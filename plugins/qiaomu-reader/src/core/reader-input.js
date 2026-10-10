/** Shared per-book zoom ranges. */
export const FONT_MIN = 12;
export const FONT_MAX = 48;
export const PDF_ZOOM_MIN = 0.5;
export const PDF_ZOOM_MAX = 3;

/** Clamp a stored number; invalid or absent values use the supplied default. */
export function bounded(value, fallback, min, max) {
  const number = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(number) && number > 0 ? number : fallback));
}

/** A button or one wheel increment; PDF zoom is relative to fit width. */
export function zoomValue(format, value, direction) {
  return format === 'pdf'
    ? Math.round(bounded(value + direction * 0.1, 1, PDF_ZOOM_MIN, PDF_ZOOM_MAX) * 100) / 100
    : Math.round(bounded(value + direction, 18, FONT_MIN, FONT_MAX));
}

/** Normalize wheel delta units to CSS pixels. */
export function wheelPixels(event, height) {
  const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
  return { x: event.deltaX * factor, y: event.deltaY * factor };
}

/** Fine wheel zoom accumulates without navigation's gesture cooldown. */
export function createZoomIntent() {
  let sum = 0; let previous = -Infinity;
  return { reset() { sum = 0; previous = -Infinity; }, push(delta, now = 0) {
    if (now - previous >= 180) sum = 0;
    previous = now;
    if (Math.sign(sum) !== Math.sign(delta)) sum = 0;
    sum += delta;
    if (Math.abs(sum) < 40) return 0;
    const direction = Math.sign(sum); sum = 0; return direction;
  } };
}

/** Intent accumulation requires a new gesture after navigation, including inertia. */
export function createWheelIntent() {
  let sum = 0;
  let previous = -Infinity;
  let blockedUntil = -Infinity;
  let needsGap = false;
  return {
    reset() { sum = 0; previous = -Infinity; blockedUntil = -Infinity; needsGap = false; },
    observe(now) { previous = now; sum = 0; needsGap = true; },
    push(delta, now) {
      const gap = now - previous;
      previous = now;
      if (needsGap && gap < 180) return 0;
      if (now < blockedUntil) return 0;
      needsGap = false;
      if (gap >= 180 || Math.sign(delta) !== Math.sign(sum)) sum = 0;
      sum += delta;
      if (Math.abs(sum) < 80) return 0;
      const direction = Math.sign(sum);
      sum = 0; blockedUntil = now + 350; needsGap = true;
      return direction;
    },
  };
}
