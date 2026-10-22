import sharp from "sharp";

/**
 * Synthetic test pictures, generated in code (never a real photo): a gradient with some detail so
 * the encoder has something to compress, optionally carrying EXIF with GPS and an orientation,
 * an ICC profile and XMP, which the photo store must drop (AC-005.1).
 */
export interface SyntheticPhotoOptions {
  readonly width?: number;
  readonly height?: number;
  readonly format?: "jpeg" | "png" | "webp" | "gif" | "tiff";
  readonly orientation?: number;
  readonly withMetadata?: boolean;
  readonly alpha?: boolean;
  readonly shade?: number;
}

/** Strings planted in the metadata; a stored photo must contain none of them. */
export const PLANTED_METADATA = ["TestCameraMaker", "SyntheticOwnerName", "planted-xmp-marker"];

export async function syntheticPhoto(options: SyntheticPhotoOptions = {}): Promise<Buffer> {
  const width = options.width ?? 640;
  const height = options.height ?? 480;
  const shade = options.shade ?? 90;
  const channels = options.alpha === true ? 4 : 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      raw[offset] = (x * 255) / width;
      raw[offset + 1] = (y * 255) / height;
      raw[offset + 2] = shade + ((x >> 4) & 1) * 40;
      if (channels === 4) {
        raw[offset + 3] = x < width / 2 ? 255 : 80;
      }
    }
  }
  let image = sharp(raw, { raw: { width, height, channels } });
  if (options.withMetadata === true) {
    image = image
      .withExif({
        IFD0: { Make: "TestCameraMaker", Artist: "SyntheticOwnerName" },
        IFD3: {
          GPSLatitudeRef: "N",
          GPSLatitude: "41/1 23/1 0/1",
          GPSLongitudeRef: "E",
          GPSLongitude: "2/1 10/1 0/1",
        },
      })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><planted-xmp-marker/></x:xmpmeta>')
      .withIccProfile("p3");
  }
  if (options.orientation !== undefined) {
    image = image.withMetadata({ orientation: options.orientation });
  }
  const format = options.format ?? "jpeg";
  return await image.toFormat(format).toBuffer();
}

/** A multipart/form-data body with one file part, as a phone browser would send it. */
export function multipartBody(
  bytes: Buffer,
  options: { fieldName?: string; fileName?: string; contentType?: string } = {},
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----sib-test-boundary-7f3a";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${options.fieldName ?? "photo"}"; filename="${options.fileName ?? "upload.jpg"}"\r\nContent-Type: ${options.contentType ?? "image/jpeg"}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
