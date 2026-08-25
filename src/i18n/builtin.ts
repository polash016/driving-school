import enMessages from "./messages/en.json";
import nbMessages from "./messages/nb.json";
import { BUILTIN_PREFIXES, type BuiltinLocale } from "@/lib/locale";

/**
 * The languages compiled into the app.
 *
 * Their catalogues are imported statically — not through the `import()` glob the request config
 * used to use — so that they are reachable with no database, no Redis and no network. Everything
 * about the runtime language registry is built on the assumption that this floor always holds.
 */
/**
 * The shape of a catalogue, taken from English.
 *
 * Typing every catalogue as this shape is what keeps next-intl's compile-time key checking alive
 * once catalogues come from the database: a runtime language is English plus overrides, so it has
 * exactly these keys by construction.
 */
export type MessageCatalogue = typeof enMessages;

export const BUILTIN_MESSAGES: Record<BuiltinLocale, MessageCatalogue> = {
  en: enMessages,
  nb: nbMessages as MessageCatalogue,
};

/** English is the universal fallback: every other catalogue is merged on top of it. */
export const BASE_MESSAGES: MessageCatalogue = enMessages;

export interface LanguageSnapshot {
  code: string;
  englishName: string;
  nativeName: string;
  shortLabel: string;
  urlPrefix: string;
  direction: "LTR" | "RTL";
  isBuiltIn: boolean;
  requiresApproval: boolean;
  studentVisible: boolean;
  fallbackCode: string;
  sortOrder: number;
}

/**
 * What the app serves when it cannot reach anything. Mirrors the seeded `Language` rows, and is
 * the reason a database outage degrades to "the original two languages" rather than to a blank
 * page — the failure mode a school actually has to survive.
 */
export const BUILTIN_LANGUAGES: LanguageSnapshot[] = [
  {
    code: "en",
    englishName: "English",
    nativeName: "English",
    shortLabel: "EN",
    urlPrefix: BUILTIN_PREFIXES.en,
    direction: "LTR",
    isBuiltIn: true,
    requiresApproval: false,
    studentVisible: true,
    fallbackCode: "en",
    sortOrder: 0,
  },
  {
    code: "nb",
    englishName: "Norwegian Bokmål",
    nativeName: "Norsk bokmål",
    shortLabel: "NO",
    urlPrefix: BUILTIN_PREFIXES.nb,
    direction: "LTR",
    isBuiltIn: true,
    requiresApproval: false,
    studentVisible: true,
    fallbackCode: "en",
    sortOrder: 1,
  },
];
