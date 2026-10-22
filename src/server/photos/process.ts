import sharp from "sharp";

// Only the decoders photos need are left on (JPEG, PNG, WebP, AVIF/HEIF from a buffer): SVG, GIF,
// TIFF, JPEG 2000, PDF and the rest are blocked in libvips, whatever a file claims to be. This is
// process-wide, which is what the app wants: every image it ever decodes is a household photo.
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({
  operation: [
    "VipsForeignLoadJpegBuffer",
    "VipsForeignLoadPngBuffer",
    "VipsForeignLoadWebpBuffer",
    "VipsForeignLoadHeifBuffer",
  ],
});

/** The longest side a stored photo may have (AC-005.1). */
export const MAX_PHOTO_SIDE = 1024;
/** Upload limit (REQ-005, design.md "Photo store"). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Decode limit against decompression bombs: a 10 MB file can claim a far larger picture. */
const MAX_INPUT_PIXELS = 80_000_000;
/** Formats accepted as input. HEIC reports as `heif` and is accepted only if the build decodes it. */
const ACCEPTED_FORMATS: ReadonlySet<string> = new Set(["jpeg", "png", "webp", "heif"]);

/** The one message the person sees for a photo that cannot be used (AC-005.6, design.md). */
export const UNSUPPORTED_PHOTO_MESSAGE =
  "This photo format isn't supported; set the camera to Most Compatible or send a JPEG";

/** The bytes are not an image this build can decode, or not an accepted format. */
export class UnsupportedPhotoError extends Error {
  override readonly name = "UnsupportedPhotoError";

  constructor(options?: ErrorOptions) {
    super(UNSUPPORTED_PHOTO_MESSAGE, options);
  }
}

const HEIF_BRANDS = [
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "mif1",
  "msf1",
  "avif",
  "avis",
];

/**
 * True when the first bytes are those of a JPEG, PNG, WebP or HEIF/AVIF file. Checked before
 * sharp sees the bytes, so nothing else (an SVG, a PDF, a script) reaches a decoder.
 */
export function hasAcceptedMagicBytes(bytes: Buffer): boolean {
  if (bytes.length < 12) {
    return false;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return true;
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return true;
  }
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    return true;
  }
  return (
    bytes.toString("latin1", 4, 8) === "ftyp" &&
    HEIF_BRANDS.includes(bytes.toString("latin1", 8, 12))
  );
}

export interface ProcessedPhoto {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * Decodes, auto-rotates and re-encodes a photo as a JPEG of at most 1024 px on the longest side
 * (AC-005.1). Nothing is copied from the input except pixels: sharp writes no EXIF, GPS, XMP or
 * ICC data unless asked, so the output carries none, and the orientation is applied to the pixels
 * first. Transparency is flattened onto white and the colour space is sRGB.
 *
 * Throws `UnsupportedPhotoError` for anything that is not a decodable JPEG, PNG, WebP or AVIF/HEIF
 * (a HEIC the installed libheif cannot decode ends up here too), never a raw decoder error.
 */
export async function processPhoto(input: Buffer): Promise<ProcessedPhoto> {
  if (!hasAcceptedMagicBytes(input)) {
    throw new UnsupportedPhotoError();
  }
  try {
    const source = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
    // Reads the header only. A picture that claims more pixels than the limit is refused here,
    // before any pixel is decoded (a small file can claim a huge picture).
    const metadata = await source.metadata();
    if (metadata.format === undefined || !ACCEPTED_FORMATS.has(metadata.format)) {
      throw new UnsupportedPhotoError();
    }
    if ((metadata.width ?? 0) * (metadata.height ?? 0) > MAX_INPUT_PIXELS) {
      throw new UnsupportedPhotoError();
    }
    const { data, info } = await source
      .autoOrient()
      .resize({
        width: MAX_PHOTO_SIDE,
        height: MAX_PHOTO_SIDE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (error) {
    throw error instanceof UnsupportedPhotoError
      ? error
      : new UnsupportedPhotoError({ cause: error });
  }
}
