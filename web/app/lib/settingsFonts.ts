// Font + weight option lists for the chat/appearance settings menu. Split out of
// settingsRegistry.ts (which is the behavior core: entries, parse/apply, prepaint
// mirror) so the large, purely-declarative option tables live on their own. Pure
// data — no imports, no side effects. Re-exported from settingsRegistry, so
// consumers keep importing FONTS/WEIGHTS from there.

export const FONT_GROUPS = ["Default", "Sans", "Rounded", "Display", "Serif", "Mono", "System"] as const;
export type FontGroup = (typeof FONT_GROUPS)[number];

// Grouped for the picker. Within a group the picker sorts by label. Fonts
// nobody picked are removed — see REMOVED_FONTS.
export const FONTS: { label: string; value: string; group: FontGroup }[] = [
  { label: "Default (Geist)",   value: "inherit", group: "Default" },
  { label: "Inter",             value: "var(--font-inter)", group: "Sans" },
  { label: "Roboto",            value: "var(--font-roboto)", group: "Sans" },
  { label: "Open Sans",         value: "var(--font-open-sans)", group: "Sans" },
  { label: "DM Sans",           value: "var(--font-dm-sans)", group: "Sans" },
  { label: "Figtree",           value: "var(--font-figtree)", group: "Sans" },
  { label: "Outfit",            value: "var(--font-outfit)", group: "Sans" },
  { label: "Lato",              value: "var(--font-lato)", group: "Sans" },
  { label: "Poppins",           value: "var(--font-poppins)", group: "Sans" },
  { label: "Mulish",            value: "var(--font-mulish)", group: "Sans" },
  { label: "Montserrat",        value: "var(--font-montserrat)", group: "Sans" },
  { label: "Urbanist",          value: "var(--font-urbanist)", group: "Sans" },
  { label: "Barlow",            value: "var(--font-barlow)", group: "Sans" },
  { label: "Chivo",             value: "var(--font-chivo)", group: "Sans" },
  { label: "Public Sans",       value: "var(--font-public-sans)", group: "Sans" },
  { label: "IBM Plex Sans",     value: "var(--font-ibm-plex)", group: "Sans" },
  { label: "Jost",              value: "var(--font-jost)", group: "Sans" },
  { label: "Titillium Web",     value: "var(--font-titillium)", group: "Sans" },
  { label: "Atkinson Hyperlegible", value: "var(--font-atkinson)", group: "Sans" },
  { label: "Onest",             value: "var(--font-onest)", group: "Sans" },
  { label: "Instrument Sans",   value: "var(--font-instrument-sans)", group: "Sans" },
  { label: "Hanken Grotesk",    value: "var(--font-hanken)", group: "Sans" },
  { label: "Albert Sans",       value: "var(--font-albert-sans)", group: "Sans" },
  { label: "Mona Sans",         value: "var(--font-mona-sans)", group: "Sans" },
  { label: "Schibsted Grotesk", value: "var(--font-schibsted)", group: "Sans" },
  { label: "Golos Text",        value: "var(--font-golos)", group: "Sans" },
  { label: "Funnel Sans",       value: "var(--font-funnel-sans)", group: "Sans" },
  { label: "Red Hat Text",      value: "var(--font-red-hat-text)", group: "Sans" },
  // Recursive is listed as a mono on Google, but its default style (the one the
  // tryout page showed) is proportional — so it sits with the sans faces.
  { label: "Recursive",         value: "var(--font-recursive)", group: "Sans" },
  { label: "Be Vietnam Pro",    value: "var(--font-be-vietnam)", group: "Sans" },
  { label: "Quicksand",         value: "var(--font-quicksand)", group: "Rounded" },
  { label: "Varela Round",      value: "var(--font-varela)", group: "Rounded" },
  { label: "Fredoka",           value: "var(--font-fredoka)", group: "Rounded" },
  { label: "Baloo 2",           value: "var(--font-baloo)", group: "Rounded" },
  { label: "M PLUS Rounded",    value: "var(--font-mplus-rounded)", group: "Rounded" },
  { label: "Josefin Sans",      value: "var(--font-josefin)", group: "Display" },
  { label: "Oswald",            value: "var(--font-oswald)", group: "Display" },
  { label: "Exo 2",             value: "var(--font-exo2)", group: "Display" },
  { label: "Teko",              value: "var(--font-teko)", group: "Display" },
  { label: "Anton",             value: "var(--font-anton)", group: "Display" },
  { label: "Russo One",         value: "var(--font-russo)", group: "Display" },
  { label: "Bebas Neue",        value: "var(--font-bebas)", group: "Display" },
  { label: "Space Grotesk",     value: "var(--font-space-grotesk)", group: "Display" },
  { label: "Bricolage Grotesque", value: "var(--font-bricolage)", group: "Display" },
  { label: "Sora",              value: "var(--font-sora)", group: "Display" },
  { label: "Merriweather",      value: "var(--font-merriweather)", group: "Serif" },
  { label: "Playfair Display",  value: "var(--font-playfair)", group: "Serif" },
  { label: "Bitter",            value: "var(--font-bitter)", group: "Serif" },
  { label: "Arvo",              value: "var(--font-arvo)", group: "Serif" },
  { label: "Literata",          value: "var(--font-literata)", group: "Serif" },
  { label: "Source Serif",      value: "var(--font-source-serif)", group: "Serif" },
  { label: "Newsreader",        value: "var(--font-newsreader)", group: "Serif" },
  { label: "Space Mono",        value: "var(--font-space-mono)", group: "Mono" },
  { label: "Geist Mono",        value: "var(--font-geist-mono)", group: "Mono" },
  { label: "JetBrains Mono",    value: "var(--font-jetbrains-mono)", group: "Mono" },
  { label: "Fira Code",         value: "var(--font-fira-code)", group: "Mono" },
  { label: "System UI",         value: "system-ui, sans-serif", group: "System" },
  { label: "Serif",             value: "Georgia, serif", group: "System" },
  { label: "Monospace",         value: "ui-monospace, monospace", group: "System" },
];

// A removed font → the closest kept one, so a saved blob, a preset or a browser
// copy that still names one keeps a similar look instead of silently falling
// back to Geist while the picker shows the default.
// @test-only production reads it through remapFont in this same file; exported so settingsFonts.test.ts can prove every replacement is a kept font
export const REMOVED_FONTS: Record<string, string> = {
  "var(--font-nunito)": "var(--font-quicksand)",
  "var(--font-raleway)": "var(--font-montserrat)",
  "var(--font-plus-jakarta)": "var(--font-dm-sans)",
  "var(--font-work-sans)": "var(--font-inter)",
  "var(--font-karla)": "var(--font-dm-sans)",
  "var(--font-manrope)": "var(--font-inter)",
  "var(--font-rubik)": "var(--font-figtree)",
  "var(--font-noto-sans)": "var(--font-open-sans)",
  "var(--font-lexend)": "var(--font-outfit)",
  "var(--font-cabin)": "var(--font-open-sans)",
  "var(--font-comfortaa)": "var(--font-quicksand)",
  "var(--font-kanit)": "var(--font-poppins)",
  "var(--font-source-sans)": "var(--font-open-sans)",
  "var(--font-lora)": "var(--font-merriweather)",
};
export const remapFont = (v: string): string => REMOVED_FONTS[v] ?? v;

export const WEIGHTS = [
  { label: "Light",  value: 300 },
  { label: "Normal", value: 400 },
  { label: "Medium", value: 500 },
  { label: "Bold",   value: 700 },
];
