import { describe, expect, it } from 'vitest';
import { CANONICAL_PLATFORMS, normalizePlatform } from '@mart/shared';

/**
 * One vocabulary, one normalizer.
 *
 * Providers spell the same device many ways, and a dimension that admits every
 * spelling is not a dimension anyone can filter on. Two adapters had already
 * diverged on what to do with an unrecognised value - one passed it through as
 * free text, the other dropped it - so the same device could be stored two ways
 * depending on which stream carried it.
 */
describe('canonical platform', () => {
  it('maps Apple devices to ios', () => {
    for (const value of [
      'ios',
      'iOS',
      'iPhone',
      'iphone',
      'iPad',
      'ipad',
      'iPod touch',
      'iOS 17',
    ]) {
      expect(normalizePlatform(value), value).toBe('ios');
    }
  });

  it('maps Android variants to android', () => {
    for (const value of [
      'android',
      'Android',
      'android_smartphone',
      'ANDROID_TABLET',
      'android tv',
    ]) {
      expect(normalizePlatform(value), value).toBe('android');
    }
  });

  it('maps browser surfaces to web', () => {
    for (const value of ['web', 'mobile_web', 'desktop', 'Desktop Browser']) {
      expect(normalizePlatform(value), value).toBe('web');
    }
  });

  it('calls everything else unknown, including absent values', () => {
    // 'unknown' is a real member, not a gap: the row exists and MART does not
    // know its device. Passing an unrecognised string through would let a
    // filter silently exclude real rows.
    for (const value of [null, undefined, '', '   ', 'nintendo_switch', 'tvos', 'smart_fridge']) {
      expect(normalizePlatform(value), String(value)).toBe('unknown');
    }
  });

  it('only ever returns a member of the canonical vocabulary', () => {
    const inputs = ['iphone', 'android_tablet', 'desktop', 'anything at all', null, ''];
    for (const value of inputs) {
      expect(CANONICAL_PLATFORMS, String(value)).toContain(normalizePlatform(value));
    }
  });
});
