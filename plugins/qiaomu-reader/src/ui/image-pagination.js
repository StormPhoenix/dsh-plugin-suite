/** Image size declarations temporarily owned by EPUB pagination, including author !important rules. */
const SIZE_PROPERTIES = ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height'];

/**
 * Fit replaced images to the current column without changing text nodes or enclosing multi-image blocks.
 * @param {HTMLElement} flow Chapter flow containing images.
 * @param {boolean} enabled Whether EPUB pagination owns image sizes.
 * @param {WeakMap<HTMLImageElement, Array<[string, string, string]>>} originals Original inline declarations, owned by the reader instance.
 * @returns {void}
 */
export function fitPageImages(flow, enabled, originals) {
  for (const image of flow.querySelectorAll('img')) {
    if (!enabled) {
      const saved = originals.get(image);
      if (!saved) continue;
      for (const [name, value, priority] of saved) {
        if (value) image.style.setProperty(name, value, priority);
        else image.style.removeProperty(name);
      }
      originals.delete(image);
      continue;
    }
    if (!originals.has(image)) originals.set(image, SIZE_PROPERTIES.map(name => [name, image.style.getPropertyValue(name), image.style.getPropertyPriority(name)]));
    image.style.setProperty('width', 'auto', 'important');
    image.style.setProperty('height', 'auto', 'important');
    image.style.setProperty('min-width', '0', 'important');
    image.style.setProperty('min-height', '0', 'important');
    const width = image.naturalWidth ? `${image.naturalWidth}px,` : '';
    const height = image.naturalHeight ? `${image.naturalHeight}px,` : '';
    image.style.setProperty('max-width', `min(${width}100%,var(--qmr-image-column-width))`, 'important');
    image.style.setProperty('max-height', `min(${height}max(1px,calc(var(--qmr-image-page-height) - 1.2em - 1lh)))`, 'important');
  }
}
