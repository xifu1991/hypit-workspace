"""Compress uploaded images before they are persisted or sent to OSS."""
from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError


DEFAULT_TARGET_BYTES = 30 * 1024


@dataclass(frozen=True)
class OptimizedImage:
    data: bytes
    mime_type: str
    extension: str
    width: int
    height: int
    original_bytes: int

    @property
    def optimized_bytes(self) -> int:
        return len(self.data)


def _normalize_image(image: Image.Image) -> Image.Image:
    image = ImageOps.exif_transpose(image)
    if image.mode in ("RGB", "RGBA", "L"):
        return image
    if image.mode == "P" and "transparency" in image.info:
        return image.convert("RGBA")
    if image.mode in ("LA", "PA"):
        return image.convert("RGBA")
    return image.convert("RGB")


def _resize_to_limit(image: Image.Image, max_dimension: int) -> Image.Image:
    width, height = image.size
    longest = max(width, height)
    if longest <= max_dimension:
        return image
    scale = max_dimension / float(longest)
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    return image.resize(size, Image.Resampling.LANCZOS)


def _encode_webp(image: Image.Image, quality: int) -> bytes:
    output = BytesIO()
    image.save(
        output,
        format="WEBP",
        quality=quality,
        method=4,
        exact=True,
    )
    return output.getvalue()


def _compress_webp(
    image: Image.Image,
    target_bytes: int,
    max_dimension: int,
) -> tuple[bytes, Image.Image]:
    current = _resize_to_limit(image, max_dimension)
    smallest: tuple[bytes, Image.Image] | None = None

    while True:
        for quality in (82, 74, 66, 58, 50, 44, 38, 32, 26):
            encoded = _encode_webp(current, quality)
            if smallest is None or len(encoded) < len(smallest[0]):
                smallest = (encoded, current.copy())
            if len(encoded) <= target_bytes:
                return encoded, current

        width, height = current.size
        longest = max(width, height)
        if longest <= 360:
            break
        next_longest = max(360, round(longest * 0.84))
        if next_longest >= longest:
            break
        scale = next_longest / float(longest)
        next_size = (max(1, round(width * scale)), max(1, round(height * scale)))
        current = current.resize(next_size, Image.Resampling.LANCZOS)

    if smallest is None:
        raise ValueError("Unable to encode image")
    return smallest


def _encode_png(image: Image.Image) -> bytes:
    output = BytesIO()
    image.save(output, format="PNG", optimize=True, compress_level=9)
    return output.getvalue()


def _compress_qr_png(
    image: Image.Image,
    target_bytes: int,
    max_dimension: int,
) -> tuple[bytes, Image.Image]:
    current = _resize_to_limit(image, max_dimension)
    smallest: tuple[bytes, Image.Image] | None = None

    while True:
        encoded = _encode_png(current)
        if smallest is None or len(encoded) < len(smallest[0]):
            smallest = (encoded, current.copy())
        if len(encoded) <= target_bytes:
            return encoded, current

        width, height = current.size
        longest = max(width, height)
        if longest <= 360:
            break
        next_longest = max(360, round(longest * 0.85))
        if next_longest >= longest:
            break
        scale = next_longest / float(longest)
        next_size = (max(1, round(width * scale)), max(1, round(height * scale)))
        current = current.resize(next_size, Image.Resampling.LANCZOS)

    if smallest is None:
        raise ValueError("Unable to encode QR image")
    return smallest


def optimize_upload_image(
    file_bytes: bytes,
    content_type: str = "",
    *,
    target_bytes: int = DEFAULT_TARGET_BYTES,
    max_dimension: int = 1600,
    profile: str = "photo",
) -> OptimizedImage:
    """Return a compressed image while preserving QR readability.

    Animated images are returned unchanged so animation is not discarded.
    """
    if not file_bytes:
        raise ValueError("Empty image")

    try:
        source = Image.open(BytesIO(file_bytes))
        source.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("Unsupported image format") from exc

    if getattr(source, "is_animated", False):
        extension = "gif" if source.format == "GIF" else "webp"
        mime_type = "image/gif" if extension == "gif" else "image/webp"
        return OptimizedImage(
            data=file_bytes,
            mime_type=mime_type,
            extension=extension,
            width=source.width,
            height=source.height,
            original_bytes=len(file_bytes),
        )

    image = _normalize_image(source)
    width, height = image.size

    if len(file_bytes) <= target_bytes and max(width, height) <= max_dimension:
        format_name = (source.format or "PNG").lower()
        extension = "jpg" if format_name in ("jpeg", "jpg") else format_name
        mime_type = "image/jpeg" if extension == "jpg" else f"image/{extension}"
        return OptimizedImage(
            data=file_bytes,
            mime_type=mime_type,
            extension=extension,
            width=width,
            height=height,
            original_bytes=len(file_bytes),
        )

    if profile == "qr":
        encoded, optimized = _compress_qr_png(image, target_bytes, max_dimension)
        mime_type, extension = "image/png", "png"
    else:
        encoded, optimized = _compress_webp(image, target_bytes, max_dimension)
        mime_type, extension = "image/webp", "webp"

    if len(encoded) > target_bytes:
        raise ValueError("Image cannot be compressed below target size")

    return OptimizedImage(
        data=encoded,
        mime_type=mime_type,
        extension=extension,
        width=optimized.width,
        height=optimized.height,
        original_bytes=len(file_bytes),
    )
