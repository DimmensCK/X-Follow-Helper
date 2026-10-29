// Synthetic examples only. No real profiles or account data.
import { constants } from './core.js';
export function createDemo() {
  const now = Date.now();
  const rows = [
    ['Aurora Studio', 'demo_aurora', true, 18420, 632, false, now - 86400000, 'Independent design, quiet mornings and things made with care.'],
    ['林间笔记', 'demo_forest', true, 8512, 390, false, now - 43200000, '记录散步、设计与日常发现。这里是演示资料。'],
    ['Milo Chen', 'demo_milo', false, 2370, 818, false, now - 3600000, 'Building small tools for everyday problems. Synthetic profile.'],
    ['Orbit Journal', 'demo_orbit', true, 42100, 128, false, null, 'Ideas about science, space and our shared future.'],
    ['Kira Field', 'demo_kira', false, 963, 245, false, null, 'Photography and ordinary moments.'],
    ['Northline', 'demo_northline', true, 12480, 476, true, null, 'A fictional publication about places and people.'],
    ['木与纸', 'demo_paper', false, 568, 274, true, null, '文字与手作。示例账号，不对应真实用户。'],
    ['Sora Systems', 'demo_sora', true, 15900, 721, true, null, 'Open ideas, thoughtful engineering.'],
    ['Small Atlas', 'demo_atlas', false, null, null, null, null, 'Relationship information is unavailable in this example.'],
    ['Quiet Signal', 'demo_signal', false, 240, 0, false, null, 'Zero following does not explain someone’s intention.'],
    ['Unavailable Demo', 'demo_unavail', false, null, null, null, null, 'A synthetic unavailable account.'],
    ['Meadow Notes', 'demo_meadow', false, 1940, 440, false, null, 'An ignored account used to demonstrate restoring visibility.'],
  ];
  const users = rows.map(([name, handle, blue, followers, followingCount, followedBy, lostAt, bio], index) => ({
    id: String(10001 + index), name, handle, blue, followers, followingCount, followedBy, lostAt, bio, avatar: '', following: true,
    unavailable: index === 10, lastExplicitFollowedBy: followedBy, lastExplicitAt: now - 120000,
  }));
  const account = {
    id: '90001', handle: 'demo_workspace', users, ignored: ['10012'],
    events: users.filter((user) => user.lostAt).map((user) => ({ type: 'lost', userId: user.id, handle: user.handle, at: user.lostAt })),
    actions: [{ id: 'demo_unknown', userId: '10005', status: 'unknown', createdAt: now - 180000, updatedAt: now - 180000, detail: 'Synthetic interrupted request' }],
    lastScan: { startedAt: now - 150000, finishedAt: now - 120000, source: 'demo', count: users.length, complete: true }, baselineAt: now - 604800000,
  };
  return {
    state: { schema: 1, settings: { language: 'zh_CN', theme: 'system', enabled: true, floatY: 0.72 }, accounts: { [account.id]: account } },
    job: null, context: { account: { id: account.id, handle: account.handle }, tabId: 1 },
    tabs: [{ id: 1, title: 'Synthetic X tab', url: 'https://x.com/home' }],
    stats: { bytes: 6812, maxBytes: constants.MAX_BYTES, accounts: 1, users: 12, events: 3, unresolved: 1 },
  };
}
