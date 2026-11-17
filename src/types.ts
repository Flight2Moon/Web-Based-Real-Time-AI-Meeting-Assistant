export type Lang = 'en' | 'ko';
export const LANGS: Record<Lang, string> = { en: 'English', ko: '한국어' }; // add languages here

export interface Meeting {
  id: string;
  title: string;
  createdAt: number; // epoch ms
  durationSec: number;
  minutes?: Minutes;
}

export interface Segment {
  id: string;
  meetingId: string;
  idx: number; // 1-based order within the meeting; used as evidence reference
  start: number; // seconds of captured audio since meeting start
  end: number;
  lang: string;
  text: string;
  translation?: string;
  refined?: boolean; // translation came from the contextual (Gemini) pass
}

interface Cited { evidence: number[] }
export interface Minutes {
  title: string;
  summary: string;
  topics: ({ title: string; points: string[] } & Cited)[];
  decisions: ({ text: string; uncertain: boolean } & Cited)[];
  actionItems: ({ task: string; owner: string | null; due: string | null; uncertain: boolean } & Cited)[];
  openQuestions: ({ text: string } & Cited)[];
  followUps: ({ text: string } & Cited)[];
  model: string;
  generatedAt: number;
}
