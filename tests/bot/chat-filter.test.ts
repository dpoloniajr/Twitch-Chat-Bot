/**
 * Unit tests for the bot's blacklist editing (src/bot/chat-filter.ts) when the
 * dashboard filter API fails. The normal paths are covered end to end in
 * tests/e2e/bot-chat-filters.test.ts.
 */

import { createChatFilter } from '../../src/bot/chat-filter';
import type { BotContext } from '../../src/bot/context';
import { readChatFilterSettings } from '../../src/bot/config';

function fakeContext(failing: boolean) {
  const call = jest.fn(async () => {
    if (failing) throw new Error('connect ECONNREFUSED');
    return { data: { success: true } };
  });
  const ctx = { http: { post: call, delete: call }, dashboardBaseUrl: 'http://dash' } as unknown as BotContext;
  return { ctx, call };
}

describe('chat filter word edits', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('saves additions and removals through the dashboard filter API', async () => {
    const { ctx, call } = fakeContext(false);
    const filter = createChatFilter(ctx, readChatFilterSettings({ CHAT_FILTER_WORDS: 'old' }));
    await expect(filter.addFilterWord('  NeW ')).resolves.toBe('saved');
    expect(call).toHaveBeenCalledWith('http://dash/api/filters/words', { word: 'new' });
    await expect(filter.removeFilterWord('a b%')).resolves.toBe('missing');
    filter.settings.blacklistWords.add('a b%');
    await expect(filter.removeFilterWord('A B%')).resolves.toBe('saved');
    expect(call).toHaveBeenLastCalledWith('http://dash/api/filters/words/a%20b%25');
    expect(filter.getFilterStatus().blacklistWords).toEqual(['old', 'new']);
  });

  it('applies the edit in memory but reports it unsaved when the dashboard is unreachable', async () => {
    const { ctx } = fakeContext(true);
    const filter = createChatFilter(ctx, readChatFilterSettings({ CHAT_FILTER_WORDS: 'old' }));
    await expect(filter.addFilterWord('spoiler')).resolves.toBe('unsaved');
    expect(filter.checkChatFiltersWithoutSideEffects('a spoiler')).toEqual(['blacklist_word']);
    await expect(filter.removeFilterWord('old')).resolves.toBe('unsaved');
    expect(filter.getFilterStatus().blacklistWords).toEqual(['spoiler']);
  });

  it('rejects empty words without calling the dashboard', async () => {
    const { ctx, call } = fakeContext(false);
    const filter = createChatFilter(ctx, readChatFilterSettings({}));
    await expect(filter.addFilterWord('   ')).resolves.toBe('invalid');
    await expect(filter.removeFilterWord('')).resolves.toBe('invalid');
    expect(call).not.toHaveBeenCalled();
  });
});
