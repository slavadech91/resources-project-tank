/** Звания 1–30 по очкам — пороги и награды старого сервера (src/scripts/client/ranks.py). */

export const RANK_SCORES = [
  0, 100, 500, 1500, 3700, 7100, 12300, 20000, 29000, 41000, 57000, 76000, 98000, 125000, 156000, 192000, 233000, 280000,
  332000, 390000, 455000, 527000, 606000, 692000, 787000, 889000, 1000000, 1122000, 1255000, 1400000,
];

/** кристаллы за получение звания */
export const RANK_REWARDS = [
  0, 10, 40, 120, 230, 420, 740, 950, 1400, 2000, 2500, 3100, 3900, 4600, 5600, 6600, 7900, 8900, 10000, 12000, 14000,
  16000, 17000, 20000, 22000, 24000, 28000, 31000, 34000, 37000,
];

export interface RankInfo {
  rank: number;
  rankScore: number;
  nextRankScore: number;
}

export function rankForScore(score: number): RankInfo {
  let index = 0;
  while (index + 1 < RANK_SCORES.length && RANK_SCORES[index + 1] <= score) index++;
  return {
    rank: index + 1,
    rankScore: RANK_SCORES[index],
    nextRankScore: RANK_SCORES[Math.min(index + 1, RANK_SCORES.length - 1)],
  };
}
