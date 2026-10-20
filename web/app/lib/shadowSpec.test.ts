// The chat shadow's DIRECTION and DISTANCE, checked by RUNNING both copies of
// the formula rather than reading them:
//   • the registry's shadowSpec() + its helpers, lifted out of settingsRegistry.ts's
//     own source (types stripped by node:module) and executed;
//   • the pre-paint script's shadow block, lifted out of app/layout.tsx and executed
//     in a fresh context over a fake localStorage / document.
//
// The two sliders must change NOBODY's chat until they are moved. BEFORE is the
// output of both copies captured from the code before the sliders existed — 32
// combinations of strength × blur × hard. At 0° / ×1 both copies must still
// produce exactly those strings, character for character.
//
// Run: node --test app/lib/shadowSpec.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as nodeModule from "node:module";
import vm from "node:vm";

// Node's own type stripper (the same one `node --test` runs this file through); the
// installed @types/node predates its declaration.
const { stripTypeScriptTypes } = nodeModule as unknown as { stripTypeScriptTypes: (src: string) => string };

type Spec = { text: string; contact: string; filter: string; box: string; halo: string };
type Pre = Record<string, string>;

const BEFORE: { s: number; bl: number; h: boolean; spec: Spec; pre: Pre }[] = [
  {"s":0.2,"bl":0.2,"h":false,"spec":{"text":"0 1px 0.80px rgba(0,0,0,0.200), 0 2px 2.40px rgba(0,0,0,0.170)","contact":"0 1px 4px rgba(0,0,0,0.200)","filter":"drop-shadow(0 1px 0.80px rgba(0,0,0,0.200))","box":"0 1px 1.60px rgba(0,0,0,0.200), 0 2px 4.80px rgba(0,0,0,0.170)","halo":"0 0 2.80px rgba(0,0,0,0.160)"},"pre":{"--chat-shadow":"0 1px 0.80px rgba(0,0,0,0.200), 0 2px 2.40px rgba(0,0,0,0.170)","--chat-shadow-filter":"drop-shadow(0 1px 0.80px rgba(0,0,0,0.200))","--chat-shadow-box":"0 1px 1.60px rgba(0,0,0,0.200), 0 2px 4.80px rgba(0,0,0,0.170)","--chat-shadow-contact":"0 1px 4px rgba(0,0,0,0.200)","--chat-shadow-halo":"0 0 2.80px rgba(0,0,0,0.160)"}},
  {"s":0.2,"bl":0.2,"h":true,"spec":{"text":"2px 2px 0 rgba(0,0,0,0.200)","contact":"2px 2px 0 rgba(0,0,0,0.200)","filter":"drop-shadow(2px 2px 0 rgba(0,0,0,0.200))","box":"2px 2px 0 rgba(0,0,0,0.200)","halo":"0 0 0 transparent"},"pre":{"--chat-shadow":"2px 2px 0 rgba(0,0,0,0.200)","--chat-shadow-contact":"2px 2px 0 rgba(0,0,0,0.200)","--chat-shadow-filter":"drop-shadow(2px 2px 0 rgba(0,0,0,0.200))","--chat-shadow-box":"2px 2px 0 rgba(0,0,0,0.200)","--chat-shadow-halo":"0 0 0 transparent"}},
  {"s":0.2,"bl":1,"h":false,"spec":{"text":"0 1px 4.00px rgba(0,0,0,0.200), 0 2px 12.00px rgba(0,0,0,0.170)","contact":"0 1px 4px rgba(0,0,0,0.200)","filter":"drop-shadow(0 1px 4.00px rgba(0,0,0,0.200))","box":"0 1px 8.00px rgba(0,0,0,0.200), 0 2px 24.00px rgba(0,0,0,0.170)","halo":"0 0 14.00px rgba(0,0,0,0.160)"},"pre":{"--chat-shadow":"0 1px 4.00px rgba(0,0,0,0.200), 0 2px 12.00px rgba(0,0,0,0.170)","--chat-shadow-filter":"drop-shadow(0 1px 4.00px rgba(0,0,0,0.200))","--chat-shadow-box":"0 1px 8.00px rgba(0,0,0,0.200), 0 2px 24.00px rgba(0,0,0,0.170)","--chat-shadow-contact":"0 1px 4px rgba(0,0,0,0.200)","--chat-shadow-halo":"0 0 14.00px rgba(0,0,0,0.160)"}},
  {"s":0.2,"bl":1,"h":true,"spec":{"text":"2px 2px 0 rgba(0,0,0,0.200)","contact":"2px 2px 0 rgba(0,0,0,0.200)","filter":"drop-shadow(2px 2px 0 rgba(0,0,0,0.200))","box":"2px 2px 0 rgba(0,0,0,0.200)","halo":"0 0 0 transparent"},"pre":{"--chat-shadow":"2px 2px 0 rgba(0,0,0,0.200)","--chat-shadow-contact":"2px 2px 0 rgba(0,0,0,0.200)","--chat-shadow-filter":"drop-shadow(2px 2px 0 rgba(0,0,0,0.200))","--chat-shadow-box":"2px 2px 0 rgba(0,0,0,0.200)","--chat-shadow-halo":"0 0 0 transparent"}},
  {"s":0.2,"bl":2.5,"h":false,"spec":{"text":"0 1px 10.00px rgba(0,0,0,0.200), 0 2px 30.00px rgba(0,0,0,0.170)","contact":"0 1px 4px rgba(0,0,0,0.200)","filter":"drop-shadow(0 1px 10.00px rgba(0,0,0,0.200))","box":"0 1px 20.00px rgba(0,0,0,0.200), 0 2px 60.00px rgba(0,0,0,0.170)","halo":"0 0 35.00px rgba(0,0,0,0.160)"},"pre":{"--chat-shadow":"0 1px 10.00px rgba(0,0,0,0.200), 0 2px 30.00px rgba(0,0,0,0.170)","--chat-shadow-filter":"drop-shadow(0 1px 10.00px rgba(0,0,0,0.200))","--chat-shadow-box":"0 1px 20.00px rgba(0,0,0,0.200), 0 2px 60.00px rgba(0,0,0,0.170)","--chat-shadow-contact":"0 1px 4px rgba(0,0,0,0.200)","--chat-shadow-halo":"0 0 35.00px rgba(0,0,0,0.160)"}},
  {"s":0.2,"bl":2.5,"h":true,"spec":{"text":"2px 2px 0 rgba(0,0,0,0.200)","contact":"2px 2px 0 rgba(0,0,0,0.200)","filter":"drop-shadow(2px 2px 0 rgba(0,0,0,0.200))","box":"2px 2px 0 rgba(0,0,0,0.200)","halo":"0 0 0 transparent"},"pre":{"--chat-shadow":"2px 2px 0 rgba(0,0,0,0.200)","--chat-shadow-contact":"2px 2px 0 rgba(0,0,0,0.200)","--chat-shadow-filter":"drop-shadow(2px 2px 0 rgba(0,0,0,0.200))","--chat-shadow-box":"2px 2px 0 rgba(0,0,0,0.200)","--chat-shadow-halo":"0 0 0 transparent"}},
  {"s":0.2,"bl":3,"h":false,"spec":{"text":"0 1px 12.00px rgba(0,0,0,0.200), 0 2px 36.00px rgba(0,0,0,0.170)","contact":"0 1px 4px rgba(0,0,0,0.200)","filter":"drop-shadow(0 1px 12.00px rgba(0,0,0,0.200))","box":"0 1px 24.00px rgba(0,0,0,0.200), 0 2px 72.00px rgba(0,0,0,0.170)","halo":"0 0 42.00px rgba(0,0,0,0.160)"},"pre":{"--chat-shadow":"0 1px 12.00px rgba(0,0,0,0.200), 0 2px 36.00px rgba(0,0,0,0.170)","--chat-shadow-filter":"drop-shadow(0 1px 12.00px rgba(0,0,0,0.200))","--chat-shadow-box":"0 1px 24.00px rgba(0,0,0,0.200), 0 2px 72.00px rgba(0,0,0,0.170)","--chat-shadow-contact":"0 1px 4px rgba(0,0,0,0.200)","--chat-shadow-halo":"0 0 42.00px rgba(0,0,0,0.160)"}},
  {"s":0.2,"bl":3,"h":true,"spec":{"text":"2px 2px 0 rgba(0,0,0,0.200)","contact":"2px 2px 0 rgba(0,0,0,0.200)","filter":"drop-shadow(2px 2px 0 rgba(0,0,0,0.200))","box":"2px 2px 0 rgba(0,0,0,0.200)","halo":"0 0 0 transparent"},"pre":{"--chat-shadow":"2px 2px 0 rgba(0,0,0,0.200)","--chat-shadow-contact":"2px 2px 0 rgba(0,0,0,0.200)","--chat-shadow-filter":"drop-shadow(2px 2px 0 rgba(0,0,0,0.200))","--chat-shadow-box":"2px 2px 0 rgba(0,0,0,0.200)","--chat-shadow-halo":"0 0 0 transparent"}},
  {"s":0.46,"bl":0.2,"h":false,"spec":{"text":"0 1px 0.80px rgba(0,0,0,0.460), 0 2px 2.40px rgba(0,0,0,0.391)","contact":"0 1px 4px rgba(0,0,0,0.460)","filter":"drop-shadow(0 1px 0.80px rgba(0,0,0,0.460))","box":"0 1px 1.60px rgba(0,0,0,0.460), 0 2px 4.80px rgba(0,0,0,0.391)","halo":"0 0 2.80px rgba(0,0,0,0.368)"},"pre":{"--chat-shadow":"0 1px 0.80px rgba(0,0,0,0.460), 0 2px 2.40px rgba(0,0,0,0.391)","--chat-shadow-filter":"drop-shadow(0 1px 0.80px rgba(0,0,0,0.460))","--chat-shadow-box":"0 1px 1.60px rgba(0,0,0,0.460), 0 2px 4.80px rgba(0,0,0,0.391)","--chat-shadow-contact":"0 1px 4px rgba(0,0,0,0.460)","--chat-shadow-halo":"0 0 2.80px rgba(0,0,0,0.368)"}},
  {"s":0.46,"bl":0.2,"h":true,"spec":{"text":"2px 2px 0 rgba(0,0,0,0.460)","contact":"2px 2px 0 rgba(0,0,0,0.460)","filter":"drop-shadow(2px 2px 0 rgba(0,0,0,0.460))","box":"2px 2px 0 rgba(0,0,0,0.460)","halo":"0 0 0 transparent"},"pre":{"--chat-shadow":"2px 2px 0 rgba(0,0,0,0.460)","--chat-shadow-contact":"2px 2px 0 rgba(0,0,0,0.460)","--chat-shadow-filter":"drop-shadow(2px 2px 0 rgba(0,0,0,0.460))","--chat-shadow-box":"2px 2px 0 rgba(0,0,0,0.460)","--chat-shadow-halo":"0 0 0 transparent"}},
  {"s":0.46,"bl":1,"h":false,"spec":{"text":"0 1px 4.00px rgba(0,0,0,0.460), 0 2px 12.00px rgba(0,0,0,0.391)","contact":"0 1px 4px rgba(0,0,0,0.460)","filter":"drop-shadow(0 1px 4.00px rgba(0,0,0,0.460))","box":"0 1px 8.00px rgba(0,0,0,0.460), 0 2px 24.00px rgba(0,0,0,0.391)","halo":"0 0 14.00px rgba(0,0,0,0.368)"},"pre":{"--chat-shadow":"0 1px 4.00px rgba(0,0,0,0.460), 0 2px 12.00px rgba(0,0,0,0.391)","--chat-shadow-filter":"drop-shadow(0 1px 4.00px rgba(0,0,0,0.460))","--chat-shadow-box":"0 1px 8.00px rgba(0,0,0,0.460), 0 2px 24.00px rgba(0,0,0,0.391)","--chat-shadow-contact":"0 1px 4px rgba(0,0,0,0.460)","--chat-shadow-halo":"0 0 14.00px rgba(0,0,0,0.368)"}},
  {"s":0.46,"bl":1,"h":true,"spec":{"text":"2px 2px 0 rgba(0,0,0,0.460)","contact":"2px 2px 0 rgba(0,0,0,0.460)","filter":"drop-shadow(2px 2px 0 rgba(0,0,0,0.460))","box":"2px 2px 0 rgba(0,0,0,0.460)","halo":"0 0 0 transparent"},"pre":{"--chat-shadow":"2px 2px 0 rgba(0,0,0,0.460)","--chat-shadow-contact":"2px 2px 0 rgba(0,0,0,0.460)","--chat-shadow-filter":"drop-shadow(2px 2px 0 rgba(0,0,0,0.460))","--chat-shadow-box":"2px 2px 0 rgba(0,0,0,0.460)","--chat-shadow-halo":"0 0 0 transparent"}},
  {"s":0.46,"bl":2.5,"h":false,"spec":{"text":"0 1px 10.00px rgba(0,0,0,0.460), 0 2px 30.00px rgba(0,0,0,0.391)","contact":"0 1px 4px rgba(0,0,0,0.460)","filter":"drop-shadow(0 1px 10.00px rgba(0,0,0,0.460))","box":"0 1px 20.00px rgba(0,0,0,0.460), 0 2px 60.00px rgba(0,0,0,0.391)","halo":"0 0 35.00px rgba(0,0,0,0.368)"},"pre":{"--chat-shadow":"0 1px 10.00px rgba(0,0,0,0.460), 0 2px 30.00px rgba(0,0,0,0.391)","--chat-shadow-filter":"drop-shadow(0 1px 10.00px rgba(0,0,0,0.460))","--chat-shadow-box":"0 1px 20.00px rgba(0,0,0,0.460), 0 2px 60.00px rgba(0,0,0,0.391)","--chat-shadow-contact":"0 1px 4px rgba(0,0,0,0.460)","--chat-shadow-halo":"0 0 35.00px rgba(0,0,0,0.368)"}},
  {"s":0.46,"bl":2.5,"h":true,"spec":{"text":"2px 2px 0 rgba(0,0,0,0.460)","contact":"2px 2px 0 rgba(0,0,0,0.460)","filter":"drop-shadow(2px 2px 0 rgba(0,0,0,0.460))","box":"2px 2px 0 rgba(0,0,0,0.460)","halo":"0 0 0 transparent"},"pre":{"--chat-shadow":"2px 2px 0 rgba(0,0,0,0.460)","--chat-shadow-contact":"2px 2px 0 rgba(0,0,0,0.460)","--chat-shadow-filter":"drop-shadow(2px 2px 0 rgba(0,0,0,0.460))","--chat-shadow-box":"2px 2px 0 rgba(0,0,0,0.460)","--chat-shadow-halo":"0 0 0 transparent"}},
  {"s":0.46,"bl":3,"h":false,"spec":{"text":"0 1px 12.00px rgba(0,0,0,0.460), 0 2px 36.00px rgba(0,0,0,0.391)","contact":"0 1px 4px rgba(0,0,0,0.460)","filter":"drop-shadow(0 1px 12.00px rgba(0,0,0,0.460))","box":"0 1px 24.00px rgba(0,0,0,0.460), 0 2px 72.00px rgba(0,0,0,0.391)","halo":"0 0 42.00px rgba(0,0,0,0.368)"},"pre":{"--chat-shadow":"0 1px 12.00px rgba(0,0,0,0.460), 0 2px 36.00px rgba(0,0,0,0.391)","--chat-shadow-filter":"drop-shadow(0 1px 12.00px rgba(0,0,0,0.460))","--chat-shadow-box":"0 1px 24.00px rgba(0,0,0,0.460), 0 2px 72.00px rgba(0,0,0,0.391)","--chat-shadow-contact":"0 1px 4px rgba(0,0,0,0.460)","--chat-shadow-halo":"0 0 42.00px rgba(0,0,0,0.368)"}},
  {"s":0.46,"bl":3,"h":true,"spec":{"text":"2px 2px 0 rgba(0,0,0,0.460)","contact":"2px 2px 0 rgba(0,0,0,0.460)","filter":"drop-shadow(2px 2px 0 rgba(0,0,0,0.460))","box":"2px 2px 0 rgba(0,0,0,0.460)","halo":"0 0 0 transparent"},"pre":{"--chat-shadow":"2px 2px 0 rgba(0,0,0,0.460)","--chat-shadow-contact":"2px 2px 0 rgba(0,0,0,0.460)","--chat-shadow-filter":"drop-shadow(2px 2px 0 rgba(0,0,0,0.460))","--chat-shadow-box":"2px 2px 0 rgba(0,0,0,0.460)","--chat-shadow-halo":"0 0 0 transparent"}},
  {"s":1,"bl":0.2,"h":false,"spec":{"text":"0 1px 0.80px rgba(0,0,0,1.000), 0 2px 2.40px rgba(0,0,0,0.850)","contact":"0 1px 4px rgba(0,0,0,1.000)","filter":"drop-shadow(0 1px 0.80px rgba(0,0,0,1.000))","box":"0 1px 1.60px rgba(0,0,0,1.000), 0 2px 4.80px rgba(0,0,0,0.850)","halo":"0 0 2.80px rgba(0,0,0,0.800)"},"pre":{"--chat-shadow":"0 1px 0.80px rgba(0,0,0,1.000), 0 2px 2.40px rgba(0,0,0,0.850)","--chat-shadow-filter":"drop-shadow(0 1px 0.80px rgba(0,0,0,1.000))","--chat-shadow-box":"0 1px 1.60px rgba(0,0,0,1.000), 0 2px 4.80px rgba(0,0,0,0.850)","--chat-shadow-contact":"0 1px 4px rgba(0,0,0,1.000)","--chat-shadow-halo":"0 0 2.80px rgba(0,0,0,0.800)"}},
  {"s":1,"bl":0.2,"h":true,"spec":{"text":"2px 2px 0 rgba(0,0,0,1.000)","contact":"2px 2px 0 rgba(0,0,0,1.000)","filter":"drop-shadow(2px 2px 0 rgba(0,0,0,1.000))","box":"2px 2px 0 rgba(0,0,0,1.000)","halo":"0 0 0 transparent"},"pre":{"--chat-shadow":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-contact":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-filter":"drop-shadow(2px 2px 0 rgba(0,0,0,1.000))","--chat-shadow-box":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-halo":"0 0 0 transparent"}},
  {"s":1,"bl":1,"h":false,"spec":{"text":"0 1px 4.00px rgba(0,0,0,1.000), 0 2px 12.00px rgba(0,0,0,0.850)","contact":"0 1px 4px rgba(0,0,0,1.000)","filter":"drop-shadow(0 1px 4.00px rgba(0,0,0,1.000))","box":"0 1px 8.00px rgba(0,0,0,1.000), 0 2px 24.00px rgba(0,0,0,0.850)","halo":"0 0 14.00px rgba(0,0,0,0.800)"},"pre":{}},
  {"s":1,"bl":1,"h":true,"spec":{"text":"2px 2px 0 rgba(0,0,0,1.000)","contact":"2px 2px 0 rgba(0,0,0,1.000)","filter":"drop-shadow(2px 2px 0 rgba(0,0,0,1.000))","box":"2px 2px 0 rgba(0,0,0,1.000)","halo":"0 0 0 transparent"},"pre":{"--chat-shadow":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-contact":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-filter":"drop-shadow(2px 2px 0 rgba(0,0,0,1.000))","--chat-shadow-box":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-halo":"0 0 0 transparent"}},
  {"s":1,"bl":2.5,"h":false,"spec":{"text":"0 1px 10.00px rgba(0,0,0,1.000), 0 2px 30.00px rgba(0,0,0,0.850)","contact":"0 1px 4px rgba(0,0,0,1.000)","filter":"drop-shadow(0 1px 10.00px rgba(0,0,0,1.000))","box":"0 1px 20.00px rgba(0,0,0,1.000), 0 2px 60.00px rgba(0,0,0,0.850)","halo":"0 0 35.00px rgba(0,0,0,0.800)"},"pre":{"--chat-shadow":"0 1px 10.00px rgba(0,0,0,1.000), 0 2px 30.00px rgba(0,0,0,0.850)","--chat-shadow-filter":"drop-shadow(0 1px 10.00px rgba(0,0,0,1.000))","--chat-shadow-box":"0 1px 20.00px rgba(0,0,0,1.000), 0 2px 60.00px rgba(0,0,0,0.850)","--chat-shadow-contact":"0 1px 4px rgba(0,0,0,1.000)","--chat-shadow-halo":"0 0 35.00px rgba(0,0,0,0.800)"}},
  {"s":1,"bl":2.5,"h":true,"spec":{"text":"2px 2px 0 rgba(0,0,0,1.000)","contact":"2px 2px 0 rgba(0,0,0,1.000)","filter":"drop-shadow(2px 2px 0 rgba(0,0,0,1.000))","box":"2px 2px 0 rgba(0,0,0,1.000)","halo":"0 0 0 transparent"},"pre":{"--chat-shadow":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-contact":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-filter":"drop-shadow(2px 2px 0 rgba(0,0,0,1.000))","--chat-shadow-box":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-halo":"0 0 0 transparent"}},
  {"s":1,"bl":3,"h":false,"spec":{"text":"0 1px 12.00px rgba(0,0,0,1.000), 0 2px 36.00px rgba(0,0,0,0.850)","contact":"0 1px 4px rgba(0,0,0,1.000)","filter":"drop-shadow(0 1px 12.00px rgba(0,0,0,1.000))","box":"0 1px 24.00px rgba(0,0,0,1.000), 0 2px 72.00px rgba(0,0,0,0.850)","halo":"0 0 42.00px rgba(0,0,0,0.800)"},"pre":{"--chat-shadow":"0 1px 12.00px rgba(0,0,0,1.000), 0 2px 36.00px rgba(0,0,0,0.850)","--chat-shadow-filter":"drop-shadow(0 1px 12.00px rgba(0,0,0,1.000))","--chat-shadow-box":"0 1px 24.00px rgba(0,0,0,1.000), 0 2px 72.00px rgba(0,0,0,0.850)","--chat-shadow-contact":"0 1px 4px rgba(0,0,0,1.000)","--chat-shadow-halo":"0 0 42.00px rgba(0,0,0,0.800)"}},
  {"s":1,"bl":3,"h":true,"spec":{"text":"2px 2px 0 rgba(0,0,0,1.000)","contact":"2px 2px 0 rgba(0,0,0,1.000)","filter":"drop-shadow(2px 2px 0 rgba(0,0,0,1.000))","box":"2px 2px 0 rgba(0,0,0,1.000)","halo":"0 0 0 transparent"},"pre":{"--chat-shadow":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-contact":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-filter":"drop-shadow(2px 2px 0 rgba(0,0,0,1.000))","--chat-shadow-box":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-halo":"0 0 0 transparent"}},
  {"s":1.5,"bl":0.2,"h":false,"spec":{"text":"0 1px 0.80px rgba(0,0,0,1.000), 0 2px 2.40px rgba(0,0,0,1.000)","contact":"0 1px 4px rgba(0,0,0,1.000)","filter":"drop-shadow(0 1px 0.80px rgba(0,0,0,1.000))","box":"0 1px 1.60px rgba(0,0,0,1.000), 0 2px 4.80px rgba(0,0,0,1.000)","halo":"0 0 2.80px rgba(0,0,0,1.000)"},"pre":{"--chat-shadow":"0 1px 0.80px rgba(0,0,0,1.000), 0 2px 2.40px rgba(0,0,0,1.000)","--chat-shadow-filter":"drop-shadow(0 1px 0.80px rgba(0,0,0,1.000))","--chat-shadow-box":"0 1px 1.60px rgba(0,0,0,1.000), 0 2px 4.80px rgba(0,0,0,1.000)","--chat-shadow-contact":"0 1px 4px rgba(0,0,0,1.000)","--chat-shadow-halo":"0 0 2.80px rgba(0,0,0,1.000)"}},
  {"s":1.5,"bl":0.2,"h":true,"spec":{"text":"2px 2px 0 rgba(0,0,0,1.000)","contact":"2px 2px 0 rgba(0,0,0,1.000)","filter":"drop-shadow(2px 2px 0 rgba(0,0,0,1.000))","box":"2px 2px 0 rgba(0,0,0,1.000)","halo":"0 0 0 transparent"},"pre":{"--chat-shadow":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-contact":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-filter":"drop-shadow(2px 2px 0 rgba(0,0,0,1.000))","--chat-shadow-box":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-halo":"0 0 0 transparent"}},
  {"s":1.5,"bl":1,"h":false,"spec":{"text":"0 1px 4.00px rgba(0,0,0,1.000), 0 2px 12.00px rgba(0,0,0,1.000)","contact":"0 1px 4px rgba(0,0,0,1.000)","filter":"drop-shadow(0 1px 4.00px rgba(0,0,0,1.000))","box":"0 1px 8.00px rgba(0,0,0,1.000), 0 2px 24.00px rgba(0,0,0,1.000)","halo":"0 0 14.00px rgba(0,0,0,1.000)"},"pre":{"--chat-shadow":"0 1px 4.00px rgba(0,0,0,1.000), 0 2px 12.00px rgba(0,0,0,1.000)","--chat-shadow-filter":"drop-shadow(0 1px 4.00px rgba(0,0,0,1.000))","--chat-shadow-box":"0 1px 8.00px rgba(0,0,0,1.000), 0 2px 24.00px rgba(0,0,0,1.000)","--chat-shadow-contact":"0 1px 4px rgba(0,0,0,1.000)","--chat-shadow-halo":"0 0 14.00px rgba(0,0,0,1.000)"}},
  {"s":1.5,"bl":1,"h":true,"spec":{"text":"2px 2px 0 rgba(0,0,0,1.000)","contact":"2px 2px 0 rgba(0,0,0,1.000)","filter":"drop-shadow(2px 2px 0 rgba(0,0,0,1.000))","box":"2px 2px 0 rgba(0,0,0,1.000)","halo":"0 0 0 transparent"},"pre":{"--chat-shadow":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-contact":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-filter":"drop-shadow(2px 2px 0 rgba(0,0,0,1.000))","--chat-shadow-box":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-halo":"0 0 0 transparent"}},
  {"s":1.5,"bl":2.5,"h":false,"spec":{"text":"0 1px 10.00px rgba(0,0,0,1.000), 0 2px 30.00px rgba(0,0,0,1.000)","contact":"0 1px 4px rgba(0,0,0,1.000)","filter":"drop-shadow(0 1px 10.00px rgba(0,0,0,1.000))","box":"0 1px 20.00px rgba(0,0,0,1.000), 0 2px 60.00px rgba(0,0,0,1.000)","halo":"0 0 35.00px rgba(0,0,0,1.000)"},"pre":{"--chat-shadow":"0 1px 10.00px rgba(0,0,0,1.000), 0 2px 30.00px rgba(0,0,0,1.000)","--chat-shadow-filter":"drop-shadow(0 1px 10.00px rgba(0,0,0,1.000))","--chat-shadow-box":"0 1px 20.00px rgba(0,0,0,1.000), 0 2px 60.00px rgba(0,0,0,1.000)","--chat-shadow-contact":"0 1px 4px rgba(0,0,0,1.000)","--chat-shadow-halo":"0 0 35.00px rgba(0,0,0,1.000)"}},
  {"s":1.5,"bl":2.5,"h":true,"spec":{"text":"2px 2px 0 rgba(0,0,0,1.000)","contact":"2px 2px 0 rgba(0,0,0,1.000)","filter":"drop-shadow(2px 2px 0 rgba(0,0,0,1.000))","box":"2px 2px 0 rgba(0,0,0,1.000)","halo":"0 0 0 transparent"},"pre":{"--chat-shadow":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-contact":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-filter":"drop-shadow(2px 2px 0 rgba(0,0,0,1.000))","--chat-shadow-box":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-halo":"0 0 0 transparent"}},
  {"s":1.5,"bl":3,"h":false,"spec":{"text":"0 1px 12.00px rgba(0,0,0,1.000), 0 2px 36.00px rgba(0,0,0,1.000)","contact":"0 1px 4px rgba(0,0,0,1.000)","filter":"drop-shadow(0 1px 12.00px rgba(0,0,0,1.000))","box":"0 1px 24.00px rgba(0,0,0,1.000), 0 2px 72.00px rgba(0,0,0,1.000)","halo":"0 0 42.00px rgba(0,0,0,1.000)"},"pre":{"--chat-shadow":"0 1px 12.00px rgba(0,0,0,1.000), 0 2px 36.00px rgba(0,0,0,1.000)","--chat-shadow-filter":"drop-shadow(0 1px 12.00px rgba(0,0,0,1.000))","--chat-shadow-box":"0 1px 24.00px rgba(0,0,0,1.000), 0 2px 72.00px rgba(0,0,0,1.000)","--chat-shadow-contact":"0 1px 4px rgba(0,0,0,1.000)","--chat-shadow-halo":"0 0 42.00px rgba(0,0,0,1.000)"}},
  {"s":1.5,"bl":3,"h":true,"spec":{"text":"2px 2px 0 rgba(0,0,0,1.000)","contact":"2px 2px 0 rgba(0,0,0,1.000)","filter":"drop-shadow(2px 2px 0 rgba(0,0,0,1.000))","box":"2px 2px 0 rgba(0,0,0,1.000)","halo":"0 0 0 transparent"},"pre":{"--chat-shadow":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-contact":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-filter":"drop-shadow(2px 2px 0 rgba(0,0,0,1.000))","--chat-shadow-box":"2px 2px 0 rgba(0,0,0,1.000)","--chat-shadow-halo":"0 0 0 transparent"}},
];

const reg = readFileSync(join(process.cwd(), "app", "lib", "settingsRegistry.ts"), "utf8");
const layout = readFileSync(join(process.cwd(), "app", "layout.tsx"), "utf8");

function lift(re: RegExp, what: string): string {
  const m = reg.match(re);
  assert.ok(m, `setup: could not find ${what} in settingsRegistry.ts`);
  return m[0];
}
const shadowSpec = (() => {
  const src = [
    lift(/^const SHADOW_BASE = .*;$/m, "SHADOW_BASE"),
    lift(/^const SHADOW_BOX_SCALE = .*;$/m, "SHADOW_BOX_SCALE"),
    lift(/^const HALO_BASE = .*;$/m, "HALO_BASE"),
    lift(/^const HARD_OFFSET_PX = .*;$/m, "HARD_OFFSET_PX"),
    lift(/^function offsetPx\([\s\S]*?\n\}/m, "offsetPx()"),
    lift(/^function shadowOffset\([\s\S]*?\n\}/m, "shadowOffset()"),
    lift(/^function shadowSpec\([\s\S]*?\n\}/m, "shadowSpec()"),
  ].join("\n");
  const fn = vm.runInNewContext(stripTypeScriptTypes(src) + "\nshadowSpec;") as
    (strength: number, blur: number, angle: number, distance: number, hard?: boolean) => Spec;
  // Spread into THIS realm: deepStrictEqual compares prototypes, and the vm's Object is not ours.
  return (strength: number, blur: number, angle: number, distance: number, hard = false): Spec =>
    ({ ...fn(strength, blur, angle, distance, hard) });
})();

// The pre-paint script's shadow block, from its first read to the seam block after it.
const block = (() => {
  const a = layout.indexOf("var _sh = localStorage.getItem('chatStyle_shadow');");
  const b = layout.indexOf("var _sm = localStorage.getItem('chatStyle_seam');");
  assert.ok(a !== -1 && b > a, "setup: could not find the pre-paint shadow block in layout.tsx");
  return layout.slice(a, b);
})();
function prePaint(store: Record<string, string>): Pre {
  const out: Pre = {};
  vm.runInNewContext(block, {
    localStorage: { getItem: (k: string) => (k in store ? store[k] : null) },
    window: { matchMedia: () => ({ matches: false }) },
    document: { documentElement: { style: { setProperty: (k: string, v: string) => { out[k] = v; } } } },
  });
  return out;
}
const asVars = (s: Spec): Pre => ({
  "--chat-shadow": s.text, "--chat-shadow-filter": s.filter, "--chat-shadow-box": s.box,
  "--chat-shadow-contact": s.contact, "--chat-shadow-halo": s.halo,
});
const store = (s: number, bl: number, h: boolean, extra: Record<string, string> = {}) => ({
  chatStyle_shadowStrength: String(s), chatStyle_shadowBlur: String(bl),
  ...(h ? { chatStyle_shadowHard: "1" } : {}), ...extra,
});

test("vacuity: the fixture is the full 32-row grid and the lifted copies really run", () => {
  assert.equal(BEFORE.length, 32);
  assert.equal(BEFORE.filter((e) => e.h).length, 16);
  assert.match(shadowSpec(1, 1, 0, 1).text, /^0 1px 4\.00px rgba/);
  assert.equal(Object.keys(prePaint(store(0.5, 1, false))).length, 5);
});

test("at 0° / ×1 the registry emits exactly what it emitted before the sliders existed", () => {
  for (const e of BEFORE) {
    assert.deepEqual(shadowSpec(e.s, e.bl, 0, 1, e.h), e.spec, `strength ${e.s}, blur ${e.bl}, hard ${e.h}`);
  }
});

test("at 0° / ×1 the pre-paint emits exactly what it emitted before — absent keys AND stored defaults", () => {
  for (const e of BEFORE) {
    assert.deepEqual(prePaint(store(e.s, e.bl, e.h)), e.pre, `absent: strength ${e.s}, blur ${e.bl}, hard ${e.h}`);
    assert.deepEqual(prePaint(store(e.s, e.bl, e.h, { chatStyle_shadowAngle: "0", chatStyle_shadowDistance: "1" })), e.pre,
      `stored 0/1: strength ${e.s}, blur ${e.bl}, hard ${e.h}`);
  }
  // Untouched sliders (1/1, soft) still write NOTHING, so globals.css :root stays the default look.
  assert.deepEqual(prePaint({}), {});
});

test("the pre-paint and the registry agree once the sliders move (every form, both styles)", () => {
  for (const angle of [-180, -135, -90, -45, -5, 0, 5, 30, 45, 90, 135, 180]) {
    for (const dist of [0, 0.3, 1, 2.5, 6]) {
      for (const [s, bl, h] of [[1, 1, false], [0.46, 2.5, false], [1.5, 0.2, true]] as const) {
        const want = asVars(shadowSpec(s, bl, angle, dist, h));
        const got = prePaint(store(s, bl, h, { chatStyle_shadowAngle: String(angle), chatStyle_shadowDistance: String(dist) }));
        if (angle === 0 && dist === 1 && s === 1 && bl === 1 && !h) assert.deepEqual(got, {});
        else assert.deepEqual(got, want, `angle ${angle}, distance ${dist}, strength ${s}, blur ${bl}, hard ${h}`);
      }
    }
  }
});

test("direction turns the drop clockwise on screen; distance scales it; the halo never moves", () => {
  const first = (a: number, d: number) => shadowSpec(1, 1, a, d).text.split(" rgba")[0];
  assert.equal(first(0, 1), "0 1px 4.00px");     // below (the old look)
  assert.equal(first(90, 1), "-1px 0 4.00px");   // clockwise a quarter: to the left
  assert.equal(first(180, 1), "0 -1px 4.00px");  // above
  assert.equal(first(-180, 1), "0 -1px 4.00px");
  assert.equal(first(-90, 1), "1px 0 4.00px");   // to the right
  assert.equal(first(0, 0), "0 0 4.00px");       // centred: an even glow
  assert.equal(first(0, 2.5), "0 2.5px 4.00px");
  assert.equal(first(-45, 2), "1.41px 1.41px 4.00px"); // down-right
  assert.equal(shadowSpec(1, 1, 0, 3).text.split(", ")[1]?.split(" rgba")[0], "0 6px 12.00px"); // wide layer: 2px × 3
  assert.equal(shadowSpec(1, 1, 90, 1, true).text, "-2px 2px 0 rgba(0,0,0,1.000)"); // hard: down-right → down-left
  assert.equal(shadowSpec(1, 1, 0, 0, true).text, "0 0 0 rgba(0,0,0,1.000)");
  for (const a of [-90, 45, 180]) for (const d of [0, 4]) {
    assert.equal(shadowSpec(0.7, 1.3, a, d).halo, shadowSpec(0.7, 1.3, 0, 1).halo);
  }
});

test("a bad stored value falls back to the default in the pre-paint (mirrors the registry's parse)", () => {
  const def = prePaint(store(0.5, 1, false));
  for (const [ang, dist] of [["999", "1"], ["abc", "1"], ["0", "-1"], ["0", "7"], ["0", "NaN"]] as const) {
    assert.deepEqual(prePaint(store(0.5, 1, false, { chatStyle_shadowAngle: ang, chatStyle_shadowDistance: dist })), def, `${ang}/${dist}`);
  }
});

test("the two rows sit under the shadow rows, on both overlay pages, shown while Shadow is on", () => {
  const menu = readFileSync(join(process.cwd(), "app", "lib", "settingsMenu.ts"), "utf8");
  assert.match(menu, /s\("shadowBlur", \(v\) => v\.shadowOn && !v\.shadowHard\),\n\s+s\("shadowAngle", \(v\) => v\.shadowOn\), s\("shadowDistance", \(v\) => v\.shadowOn\),/);
  const ov = menu.match(/export const OVERLAY_KEYS = new Set<SettingKey>\(\[[\s\S]*?\]\);/)?.[0] ?? "";
  assert.ok(ov.includes('"shadowAngle"') && ov.includes('"shadowDistance"'), "the /chat and OBS pages lost the two rows");
  assert.match(reg, /shadowAngle: E\(\{ ls: "chatStyle_shadowAngle", prePaint: true,/);
  assert.match(reg, /shadowDistance: E\(\{ ls: "chatStyle_shadowDistance", prePaint: true,/);
  assert.match(reg, /shadowAngle: {4}0,\n {2}shadowDistance: 1,/);
});
