import sharp from "sharp";

/**
 * The generated photos of the sample data: flat colours and simple shapes drawn pixel by pixel,
 * never a real photo and nothing of a home. They go through the same upload path as a real photo
 * (resize, no metadata).
 */
export type Scene = "plants_fine" | "plants_dry" | "line_dry" | "line_wet";

const WIDTH = 640;
const HEIGHT = 480;
const CHANNELS = 3;

type Colour = readonly [number, number, number];

class Canvas {
  readonly pixels = Buffer.alloc(WIDTH * HEIGHT * CHANNELS);

  fill(colour: Colour): void {
    this.rect(0, 0, WIDTH, HEIGHT, colour);
  }

  private put(x: number, y: number, colour: Colour): void {
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) {
      return;
    }
    const offset = (y * WIDTH + x) * CHANNELS;
    this.pixels[offset] = colour[0];
    this.pixels[offset + 1] = colour[1];
    this.pixels[offset + 2] = colour[2];
  }

  rect(left: number, top: number, width: number, height: number, colour: Colour): void {
    for (let y = top; y < top + height; y += 1) {
      for (let x = left; x < left + width; x += 1) {
        this.put(x, y, colour);
      }
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, colour: Colour): void {
    for (let y = cy - ry; y <= cy + ry; y += 1) {
      for (let x = cx - rx; x <= cx + rx; x += 1) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) {
          this.put(Math.round(x), Math.round(y), colour);
        }
      }
    }
  }

  /** A thick line from (x1, y1) to (x2, y2). */
  line(x1: number, y1: number, x2: number, y2: number, thickness: number, colour: Colour): void {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
    for (let step = 0; step <= steps; step += 1) {
      const x = Math.round(x1 + ((x2 - x1) * step) / steps);
      const y = Math.round(y1 + ((y2 - y1) * step) / steps);
      this.rect(
        x - Math.floor(thickness / 2),
        y - Math.floor(thickness / 2),
        thickness,
        thickness,
        colour,
      );
    }
  }
}

function pot(canvas: Canvas, x: number, fine: boolean): void {
  const leaves: Colour = fine ? [79, 154, 74] : [160, 154, 74];
  const soil: Colour = fine ? [74, 54, 38] : [181, 154, 114];
  if (fine) {
    canvas.line(x, 300, x, 200, 8, leaves);
    canvas.ellipse(x - 24, 205, 28, 12, leaves);
    canvas.ellipse(x + 24, 195, 28, 12, leaves);
    canvas.ellipse(x, 172, 12, 28, leaves);
  } else {
    canvas.line(x, 300, x - 40, 255, 8, leaves);
    canvas.ellipse(x - 55, 268, 30, 12, leaves);
  }
  canvas.rect(x - 55, 300, 110, 90, [181, 101, 74]);
  canvas.rect(x - 55, 300, 110, 18, soil);
}

function plants(fine: boolean): Canvas {
  const canvas = new Canvas();
  canvas.fill(fine ? [207, 227, 239] : [232, 220, 192]);
  canvas.rect(0, 390, WIDTH, 90, [141, 139, 132]);
  pot(canvas, 170, fine);
  pot(canvas, 470, fine);
  return canvas;
}

function line(dry: boolean): Canvas {
  const canvas = new Canvas();
  canvas.fill(dry ? [216, 235, 246] : [143, 155, 165]);
  canvas.line(30, 120, 610, 130, 4, [74, 71, 64]);
  const cloth: readonly Colour[] = dry
    ? [
        [244, 241, 232],
        [231, 176, 74],
        [127, 176, 214],
      ]
    : [
        [143, 163, 179],
        [141, 122, 90],
        [95, 127, 154],
      ];
  canvas.rect(80, 126, 120, dry ? 190 : 230, cloth[0]!);
  canvas.rect(250, 127, 140, 150, cloth[1]!);
  canvas.rect(440, 128, 110, dry ? 200 : 250, cloth[2]!);
  if (!dry) {
    for (let index = 0; index < 14; index += 1) {
      const x = 40 + index * 45;
      const y = 20 + (index % 3) * 50;
      canvas.line(x, y, x - 10, y + 40, 3, [95, 127, 154]);
    }
  }
  return canvas;
}

const SCENES: Readonly<Record<Scene, () => Canvas>> = {
  plants_fine: () => plants(true),
  plants_dry: () => plants(false),
  line_dry: () => line(true),
  line_wet: () => line(false),
};

/** A JPEG of the scene. */
export function scenePhoto(scene: Scene): Promise<Buffer> {
  return sharp(SCENES[scene]().pixels, {
    raw: { width: WIDTH, height: HEIGHT, channels: CHANNELS },
  })
    .jpeg({ quality: 82 })
    .toBuffer();
}
