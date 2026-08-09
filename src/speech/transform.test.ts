import { describe, expect, it } from "vitest";
import { DEFAULT_TRANSFORM, fixMojibake, transformForSpeech } from "./transform";

const one = (raw: string) => transformForSpeech(raw).join(" ");

describe("mojibake", () => {
  it("repairs the known Windows-1252 sequences", () => {
    expect(fixMojibake("wait â€” really â€œyesâ€™")).toBe("wait — really \"yes'");
    expect(fixMojibake("cafÃ© rÃ©sumÃ©")).toBe("café résumé");
    expect(fixMojibake("loadingâ€¦")).toBe("loading…");
  });

  it("leaves clean prose untouched", () => {
    const clean = "An em dash — and “curly quotes” survive unharmed.";
    expect(fixMojibake(clean)).toBe(clean);
  });
});

describe("code fences", () => {
  it("announces fences once", () => {
    const out = one("Before.\n```ts\nconst x = 1;\nconst y = 2;\n```\nAfter.");
    expect(out).toContain("Code block.");
    expect(out).not.toContain("const x");
    expect(out).toContain("Before.");
    expect(out).toContain("After.");
  });

  it("collapses consecutive fences", () => {
    const out = one("A.\n```\nx\n```\n```\ny\n```\nB.");
    expect(out.match(/Code block\./g)?.length).toBe(1);
  });

  it("drops fence content when announceCode off", () => {
    const out = transformForSpeech("Hi.\n```\nsecret\n```\nBye.", {
      ...DEFAULT_TRANSFORM,
      announceCode: false,
    }).join(" ");
    expect(out).not.toContain("secret");
    expect(out).not.toContain("Code block");
  });

  it("cuts everything after an unterminated fence", () => {
    const out = one("Real words.\n```\nnever closed\nmore code");
    expect(out).not.toContain("never closed");
  });
});

describe("structure", () => {
  it("tables become one phrase", () => {
    const out = one("Data:\n| a | b |\n|---|---|\n| 1 | 2 |\nDone.");
    expect(out).toContain("Table omitted.");
    expect(out).not.toContain("| a |");
  });

  it("headers become sentences", () => {
    expect(one("## The Plan\nWe act now.")).toBe("The Plan. We act now.");
  });

  it("bullets flatten with terminal punctuation", () => {
    const out = one("- first thing\n- second thing.");
    expect(out).toBe("first thing. second thing.");
  });

  it("blockquotes lose their markers", () => {
    expect(one("> quoted wisdom here.")).toBe("quoted wisdom here.");
  });
});

describe("inline", () => {
  it("links keep their text, bare urls become hostnames", () => {
    expect(one("See [the docs](https://example.com/x) at https://api.elevenlabs.io/v1/tts.")).toBe(
      "See the docs at api.elevenlabs.io."
    );
  });

  it("inline code keeps content", () => {
    expect(one("Run `npm install` now.")).toBe("Run npm install now.");
  });

  it("file paths shrink to basenames", () => {
    expect(one("Edited D:\\Vxrcel\\shadow-garden\\components\\shell\\PillTabs.tsx today.")).toBe(
      "Edited PillTabs.tsx today."
    );
    expect(one("Check src/components/shell/TopBar.tsx please.")).toBe(
      "Check TopBar.tsx please."
    );
  });

  it("emphasis markers vanish, arrows read as to", () => {
    expect(one("**bold** and *italic* go a → b.")).toBe("bold and italic go a to b.");
  });
});

describe("cap and chunk", () => {
  it("caps long text at a sentence boundary with a suffix", () => {
    const sentence = "This sentence is repeated to overflow the cap. ";
    const out = transformForSpeech(sentence.repeat(60));
    const joined = out.join(" ");
    expect(joined.length).toBeLessThan(1400);
    expect(joined).toContain("… and more.");
  });

  it("packs sentences into chunks ≤ ~420 chars", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} carries some weight.`).join(" ");
    const chunks = transformForSpeech(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(440);
  });

  it("hard-splits a monster sentence", () => {
    const monster = `start ${"word ".repeat(200)}end.`;
    const chunks = transformForSpeech(monster);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(440);
  });
});

describe("drops", () => {
  it("pure code block with announce off yields nothing", () => {
    expect(
      transformForSpeech("```\nx\n```", { ...DEFAULT_TRANSFORM, announceCode: false })
    ).toEqual([]);
  });

  it("whitespace and symbol-only input yields nothing", () => {
    expect(transformForSpeech("   \n\n  ")).toEqual([]);
    expect(transformForSpeech("---")).toEqual([]);
  });

  it("ordinary prose ends with terminal punctuation", () => {
    expect(one("no punctuation here")).toBe("no punctuation here.");
  });
});
