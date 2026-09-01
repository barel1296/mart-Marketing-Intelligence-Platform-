import { describe, expect, it } from 'vitest';
import {
  CANONICAL_CHANNELS,
  channelForMediaSource,
  channelForProvider,
  isPaidChannel,
  mediaSourcesForChannel,
} from '@mart/shared';

/**
 * Channel is the axis that survives adding a provider.
 *
 * "How much came from paid social" must not require knowing which networks
 * MART happens to be connected to this quarter. provider_key stays beside it
 * and answers the narrower question of who reported the row.
 */
describe('canonical channel', () => {
  it('classifies the providers MART declares', () => {
    expect(channelForProvider('meta_ads')).toBe('paid_social');
    expect(channelForProvider('tiktok_ads')).toBe('paid_social');
    expect(channelForProvider('google_ads')).toBe('paid_search');
    expect(channelForProvider('unity_ads')).toBe('paid_network');
    expect(channelForProvider('applovin')).toBe('paid_network');
  });

  it('calls an unclassified provider unknown rather than guessing', () => {
    // A guess here would be indistinguishable from knowledge downstream.
    expect(channelForProvider('some_new_network')).toBe('unknown');
    expect(channelForProvider(null)).toBe('unknown');
  });

  it('treats organic as its own channel, not as a missing one', () => {
    // Unpaid traffic is a real acquisition source. Filing it under `unknown`
    // would put it in the same bucket as a provider nobody has classified.
    expect(channelForMediaSource('organic')).toBe('organic');
    expect(channelForMediaSource(null)).toBe('organic');
    expect(channelForMediaSource(undefined)).toBe('organic');
    expect(isPaidChannel('organic')).toBe(false);
    expect(isPaidChannel('unknown')).toBe(false);
    expect(isPaidChannel('paid_social')).toBe(true);
  });

  it('maps the network name an MMP reports, not just the provider key', () => {
    // MMPs report the network - "facebook", "tiktok" - never MART's key.
    expect(channelForMediaSource('facebook')).toBe('paid_social');
    expect(channelForMediaSource('tiktok')).toBe('paid_social');
    expect(channelForMediaSource('google')).toBe('paid_search');
    expect(channelForMediaSource('unity')).toBe('paid_network');
  });

  it('never infers a channel from anything but the declared mapping', () => {
    // Campaign names are free text an operator can change at any time. A
    // dimension derived from them would change when somebody renames a
    // campaign, which is not a property of the traffic.
    expect(channelForMediaSource('FB_App_CPI_Broad_US_paid_social')).toBe('unknown');
    expect(channelForMediaSource('search_campaign_brand')).toBe('unknown');
  });

  it('generates its media-source lists from the same table the labels use', () => {
    const social = mediaSourcesForChannel('paid_social');
    expect(social).toContain('meta_ads');
    expect(social).toContain('meta');
    expect(social).toContain('facebook_ads');
    expect(social).toContain('facebook');
    expect(social).toContain('tiktok');
    expect(social).not.toContain('google_ads');
    // Every generated source classifies back to the channel it came from.
    for (const channel of CANONICAL_CHANNELS) {
      if (channel === 'organic' || channel === 'unknown') continue;
      for (const source of mediaSourcesForChannel(channel)) {
        expect(channelForMediaSource(source), `${channel}/${source}`).toBe(channel);
      }
    }
  });
});
