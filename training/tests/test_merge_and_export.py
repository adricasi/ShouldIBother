import json
import shlex
import sys
from pathlib import Path

import pytest
from helpers import write_config

from training import merge_and_export as export
from training.config import TrainConfig, load_config


def make_config(tmp_path: Path, *, extra: str = "") -> tuple[Path, Path, Path]:
    output = tmp_path / "out"
    llama = tmp_path / "llama.cpp"
    return (
        write_config(tmp_path, output_dir=output, llama_cpp_dir=llama, extra=extra),
        output,
        llama,
    )


def prepare(output: Path, llama: Path) -> None:
    """Lay down the inputs the real steps would find: adapter, converter script, quantizer."""
    (output / "adapter").mkdir(parents=True)
    (output / "adapter" / "adapter_config.json").write_text("{}")
    llama.mkdir()
    (llama / "convert_hf_to_gguf.py").write_text("")
    (llama / "build" / "bin").mkdir(parents=True)
    (llama / "build" / "bin" / "llama-quantize").write_text("")


class FakeTools:
    """Replaces the merge and the two llama.cpp commands; records what the script asked for."""

    def __init__(self, output: Path) -> None:
        self.output = output
        self.steps: list[export.Step] = []
        self.merges = 0

    def merger(self, config: TrainConfig, paths: export.ExportPaths) -> None:
        self.merges += 1
        paths.merged_dir.mkdir(parents=True)
        (paths.merged_dir / "config.json").write_text("{}")

    def runner(self, step: export.Step) -> None:
        self.steps.append(step)
        if "--outfile" in step.argv:  # the converter: ... --outfile <f16.gguf> --outtype f16
            target = Path(step.argv[step.argv.index("--outfile") + 1])
        else:  # the quantizer: <binary> <in.gguf> <out.gguf> <type>
            target = Path(step.argv[2])
        target.write_bytes(b"gguf-bytes")


def run(config: Path, tools: FakeTools, *extra: str) -> tuple[int, str]:
    lines: list[str] = []
    code = export.main(
        ["--config", str(config), *extra],
        merger=tools.merger,
        runner=tools.runner,
        echo=lines.append,
    )
    return code, "\n".join(lines)


def test_the_dry_run_lists_every_step_and_writes_nothing(tmp_path: Path) -> None:
    config, output, llama = make_config(tmp_path)
    tools = FakeTools(output)
    code, text = run(config, tools, "--dry-run")
    assert code == 0
    assert "convert_hf_to_gguf.py" in text
    assert "--outtype f16" in text
    assert "llama-quantize" in text
    assert "Q4_K_M" in text
    assert "FROM " in text
    assert f"ollama create sib-bookmaker-ft:v1 -f {output / 'Modelfile'}" in text
    assert "Dry run" in text
    assert tools.steps == []
    assert tools.merges == 0
    assert not output.exists()


def test_dry_run_imports_no_ml_library(tmp_path: Path) -> None:
    import subprocess

    config, _, _ = make_config(tmp_path)
    src = Path(export.__file__).parents[1]
    code = (
        f"import sys; sys.path.insert(0, {str(src)!r})\n"
        "from training import merge_and_export as e\n"
        f"rc = e.main(['--config', {str(config)!r}, '--dry-run'], echo=lambda s: None)\n"
        "print(rc, [m for m in ('torch','transformers','peft') if m in sys.modules])"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=True
    )
    assert result.stdout.strip() == "0 []"


def test_the_full_run_merges_converts_quantizes_and_writes_the_modelfile(tmp_path: Path) -> None:
    config, output, llama = make_config(tmp_path)
    prepare(output, llama)
    tools = FakeTools(output)
    code, text = run(config, tools)
    assert code == 0, text
    assert tools.merges == 1
    convert, quantize = tools.steps
    assert convert.argv[0] == sys.executable
    assert convert.argv[1] == str(llama / "convert_hf_to_gguf.py")
    assert convert.argv[2] == str(output / "merged")
    assert quantize.argv[0] == str(llama / "build" / "bin" / "llama-quantize")
    assert quantize.argv[-1] == "Q4_K_M"

    gguf = output / "gguf" / "sib-bookmaker-ft-v1-q4_k_m.gguf"
    modelfile = (output / "Modelfile").read_text()
    assert f"FROM {gguf}\n" in modelfile
    assert "PARAMETER temperature 0.0" in modelfile
    assert "PARAMETER seed 42" in modelfile
    assert "PARAMETER num_ctx 8192" in modelfile
    assert "TODO(builder) UNVERIFIED" in modelfile

    record = json.loads((output / "export-record.json").read_text())
    import hashlib

    assert record["gguf_sha256"] == hashlib.sha256(b"gguf-bytes").hexdigest()
    assert record["ollama_tag"] == "sib-bookmaker-ft:v1"
    assert set(record["packages"]) >= {"torch", "peft"}


def test_the_ollama_create_command_is_printed_and_never_run(tmp_path: Path) -> None:
    config, output, llama = make_config(tmp_path)
    prepare(output, llama)
    tools = FakeTools(output)
    code, text = run(config, tools)
    assert code == 0
    last = text.splitlines()[-1].strip()
    assert shlex.split(last) == [
        "ollama",
        "create",
        "sib-bookmaker-ft:v1",
        "-f",
        str(output / "Modelfile"),
    ]
    # Only the converter and the quantizer were run: nothing called ollama.
    assert all(Path(step.argv[0]).name != "ollama" for step in tools.steps)


def test_a_template_file_is_written_into_the_modelfile(tmp_path: Path) -> None:
    template = tmp_path / "template.txt"
    template.write_text('TEMPLATE """{{ .Prompt }}"""\n', encoding="utf-8")
    config, output, llama = make_config(tmp_path)
    config.write_text(
        config.read_text().replace('template_file = ""', f'template_file = "{template}"')
    )
    prepare(output, llama)
    assert run(config, FakeTools(output))[0] == 0
    assert 'TEMPLATE """{{ .Prompt }}"""' in (output / "Modelfile").read_text()
    assert "TODO(builder)" not in (output / "Modelfile").read_text()


def test_a_missing_adapter_stops_the_merge(tmp_path: Path) -> None:
    config, output, _ = make_config(tmp_path)
    tools = FakeTools(output)
    code, text = run(config, tools)
    assert code == export.EXIT_STEP_FAILED
    assert "adapter" in text
    assert tools.merges == 0


def test_missing_llama_cpp_stops_the_conversion(tmp_path: Path) -> None:
    config, output, llama = make_config(tmp_path)
    prepare(output, llama)
    (llama / "build" / "bin" / "llama-quantize").unlink()
    code, text = run(config, FakeTools(output))
    assert code == export.EXIT_STEP_FAILED
    assert "quantizer" in text


def test_a_stage_runs_alone(tmp_path: Path) -> None:
    config, output, llama = make_config(tmp_path)
    prepare(output, llama)
    tools = FakeTools(output)
    assert run(config, tools, "--stage", "merge")[0] == 0
    assert (tools.merges, tools.steps) == (1, [])
    assert run(config, tools, "--stage", "gguf")[0] == 0
    assert len(tools.steps) == 2
    assert not (output / "Modelfile").exists()
    assert run(config, tools, "--stage", "modelfile")[0] == 0
    assert (output / "Modelfile").exists()


def test_a_failing_command_is_reported_with_its_command_line(tmp_path: Path) -> None:
    config, output, llama = make_config(tmp_path)
    prepare(output, llama)
    tools = FakeTools(output)

    def failing(step: export.Step) -> None:
        raise export.ExportError(f"{step.description} failed (exit 1)")

    lines: list[str] = []
    code = export.main(
        ["--config", str(config)], merger=tools.merger, runner=failing, echo=lines.append
    )
    assert code == export.EXIT_STEP_FAILED
    assert "failed (exit 1)" in lines[-1]


def test_the_real_runner_reports_a_nonzero_exit_and_accepts_zero() -> None:
    export._run_step(export.Step("ok", (sys.executable, "-c", "pass")))
    with pytest.raises(export.ExportError, match="exit 3"):
        export._run_step(export.Step("bad", (sys.executable, "-c", "raise SystemExit(3)")))


def test_the_committed_template_renders_for_the_committed_config() -> None:
    config = load_config()
    text = export.render_modelfile(
        export.DEFAULT_TEMPLATE_PATH.read_text(), config, Path("/models/x.gguf"), "TEMPLATE x"
    )
    assert text.splitlines()[2] == "FROM /models/x.gguf"
    assert text.rstrip().endswith("TEMPLATE x")


def test_a_bad_config_or_output_inside_the_repository_is_refused(tmp_path: Path) -> None:
    lines: list[str] = []
    assert export.main(["--config", str(tmp_path / "none.toml")], echo=lines.append) == 2
    config, _, _ = make_config(tmp_path)
    code = export.main(
        ["--config", str(config), "--output-dir", str(export.DEFAULT_TEMPLATE_PATH.parent / "x")],
        echo=lines.append,
    )
    assert code == 2
    assert "inside the repository" in lines[-1]
