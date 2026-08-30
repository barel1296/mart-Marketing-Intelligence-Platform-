import { describe, expect, it } from 'vitest';
import { attributionNameKeys, embeddedNames, nameKey } from '@mart/integrations';

/**
 * The deterministic Meta <-> Tenjin name relationship, pinned against the real
 * campaign names from the account this was built for.
 *
 * Tenjin names a campaign for its creative or ad set and carries the ad
 * network's own campaign name in parentheses. That is an exact substring
 * relationship, not a resemblance - which is why it is allowed to produce a
 * high-confidence mapping, and why nothing may be stripped from inside the
 * parentheses before comparing.
 */

const META_STATIC = 'FB_Reveal_Rush_CPI_Broad_US_26/08/26';
const META_NEW_CR = 'FB_Reveal_Rush_CPI_Broad_US_NEW_CR__29/08/26';

const TENJIN_STATIC = 'CPI_Broad_US_static (FB_Reveal_Rush_CPI_Broad_US_26/08/26)';
const TENJIN_VIDEO = 'CPI_Broad_US_video (FB_Reveal_Rush_CPI_Broad_US_26/08/26)';
const TENJIN_NEW_CR = 'New App promotion Ad Set (FB_Reveal_Rush_CPI_Broad_US_NEW_CR__29/08/26)';

describe('embedded provider names', () => {
  it('extracts the network campaign name from the MMP campaign name', () => {
    expect(embeddedNames(TENJIN_STATIC)).toEqual([META_STATIC]);
    expect(embeddedNames(TENJIN_VIDEO)).toEqual([META_STATIC]);
    expect(embeddedNames(TENJIN_NEW_CR)).toEqual([META_NEW_CR]);
  });

  it('finds nothing to extract when there are no parentheses', () => {
    expect(embeddedNames(META_STATIC)).toEqual([]);
    expect(embeddedNames('Organic')).toEqual([]);
    expect(embeddedNames(null)).toEqual([]);
  });

  it('matches the real Tenjin names to the real Meta names', () => {
    for (const tenjin of [TENJIN_STATIC, TENJIN_VIDEO]) {
      expect(attributionNameKeys(tenjin), tenjin).toContain(nameKey(META_STATIC));
    }
    expect(attributionNameKeys(TENJIN_NEW_CR)).toContain(nameKey(META_NEW_CR));
  });

  it('keeps two campaigns that differ only by date apart', () => {
    // The whole risk of name matching: 26/08 and 29/08 are different campaigns
    // and nothing in normalization may erase the difference.
    expect(nameKey(META_STATIC)).not.toBe(nameKey(META_NEW_CR));
    expect(attributionNameKeys(TENJIN_STATIC)).not.toContain(nameKey(META_NEW_CR));
    expect(attributionNameKeys(TENJIN_NEW_CR)).not.toContain(nameKey(META_STATIC));
  });

  it('does not match a name that merely resembles another', () => {
    expect(attributionNameKeys('CPI_Broad_US_static (FB_Reveal_Rush_CPI_Broad_US)')).not.toContain(
      nameKey(META_STATIC),
    );
    expect(
      attributionNameKeys('CPI_Broad_US_static (FB_Reveal_Rush_CPI_Broad_DE_26/08/26)'),
    ).not.toContain(nameKey(META_STATIC));
  });

  it('normalizes only what is typography, never what is identity', () => {
    // Case, spacing and punctuation are not identity.
    expect(nameKey('  FB_Reveal_Rush   CPI  ')).toBe(nameKey('fb_reveal_rush_cpi'));
    // A non-breaking space is a space; composed and decomposed accents are the
    // same letter.
    expect(nameKey('Rush US')).toBe(nameKey('Rush US'));
    expect(nameKey('Camión')).toBe(nameKey('Camión'));
    // Numbers, dates, country codes and creative markers are identity.
    expect(nameKey('CPI_Broad_US_26/08/26')).not.toBe(nameKey('CPI_Broad_US_26/08/27'));
    expect(nameKey('CPI_Broad_US')).not.toBe(nameKey('CPI_Broad_DE'));
    expect(nameKey('CPI_static')).not.toBe(nameKey('CPI_video'));
  });

  it('offers the whole name first, then each embedded one', () => {
    const keys = attributionNameKeys(TENJIN_STATIC);
    expect(keys[0]).toBe(nameKey(TENJIN_STATIC));
    expect(keys[1]).toBe(nameKey(META_STATIC));
    expect(keys).toHaveLength(2);
  });

  it('handles several embedded names without preferring a guess', () => {
    expect(embeddedNames('A (one) B (two)')).toEqual(['one', 'two']);
  });
});
