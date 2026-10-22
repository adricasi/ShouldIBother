import type { Notice } from "../notice.js";

/** A message above the screen: errors are announced at once (alert), information politely (status). */
export function NoticeBanner({ notice }: { notice: Notice | undefined }) {
  if (notice === undefined) {
    return null;
  }
  return (
    <p className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
      {notice.text}
    </p>
  );
}
