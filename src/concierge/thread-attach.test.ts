/**
 * Thread-attach tests (`src/concierge/thread-attach.ts`).
 * The negative cases are the point. `&` is an ordinary character in chat, so the parser earns
 * its keep by refusing everything that is not EXACTLY the command: prose containing a ref,
 * trailing words, two commands in one message, a space after the `&`. Those refusals are
 * enumerated far more generously than the handful of accepts below them.
 */

import { describe, expect, test } from "bun:test";
import { parseAttachCommand } from "./thread-attach.ts";

describe("parseAttachCommand — accepts", () => {
  test("&recent, any casing", () => {
    for (const s of ["&recent", "&RECENT", "&Recent", "&ReCeNt"]) {
      expect(parseAttachCommand(s)).toEqual({ kind: "recent" });
    }
  });

  test("&clear, any casing", () => {
    for (const s of ["&clear", "&CLEAR", "&Clear"]) {
      expect(parseAttachCommand(s)).toEqual({ kind: "clear" });
    }
  });

  test("a bare task ref", () => {
    expect(parseAttachCommand("&12")).toEqual({ kind: "task", ref: "12" });
    expect(parseAttachCommand("&1")).toEqual({ kind: "task", ref: "1" });
    expect(parseAttachCommand("&987654")).toEqual({ kind: "task", ref: "987654" });
  });

  test("the '#' spelling normalizes away", () => {
    expect(parseAttachCommand("&#12")).toEqual({ kind: "task", ref: "12" });
    expect(parseAttachCommand("&#12.1")).toEqual({ kind: "task", ref: "12.1" });
  });

  test("dotted sub-refs up to four segments", () => {
    expect(parseAttachCommand("&12.1")).toEqual({ kind: "task", ref: "12.1" });
    expect(parseAttachCommand("&12.1.3")).toEqual({ kind: "task", ref: "12.1.3" });
    expect(parseAttachCommand("&12.1.3.4")).toEqual({ kind: "task", ref: "12.1.3.4" });
  });

  test("surrounding whitespace around the WHOLE content is forgiven", () => {
    expect(parseAttachCommand("  &12  ")).toEqual({ kind: "task", ref: "12" });
    expect(parseAttachCommand("\n&12\n")).toEqual({ kind: "task", ref: "12" });
    expect(parseAttachCommand("\t&recent\t")).toEqual({ kind: "recent" });
    expect(parseAttachCommand("&clear\r\n")).toEqual({ kind: "clear" });
  });

  test("unicode whitespace around the content is forgiven too", () => {
    // NBSP, ideographic space, line/paragraph separators — all arrive via copy-paste.
    expect(parseAttachCommand(" &12 ")).toEqual({ kind: "task", ref: "12" });
    expect(parseAttachCommand("　&recent")).toEqual({ kind: "recent" });
    expect(parseAttachCommand("&clear ")).toEqual({ kind: "clear" });
    expect(parseAttachCommand(" &12.1 ")).toEqual({ kind: "task", ref: "12.1" });
  });
});

describe("parseAttachCommand — rejects anything that is not exactly the command", () => {
  test("empty and whitespace-only content", () => {
    for (const s of ["", " ", "\n", "\t\t", " ", "　  \n"]) {
      expect(parseAttachCommand(s)).toBeNull();
    }
  });

  test("a lone '&' is not a command", () => {
    expect(parseAttachCommand("&")).toBeNull();
    expect(parseAttachCommand("  &  ")).toBeNull();
    expect(parseAttachCommand("&#")).toBeNull();
  });

  test("ordinary prose containing '&' never attaches", () => {
    for (const s of [
      "tom & jerry",
      "&recent is a good idea",
      "go &12",
      "see &12 for context",
      "fix &12 and &13 please",
      "R&D",
      "a & b & c",
      "AT&T",
    ]) {
      expect(parseAttachCommand(s)).toBeNull();
    }
  });

  test("trailing content after a valid command", () => {
    for (const s of ["&12 please", "&12 ok", "&recent please", "&clear all", "&12,", "&12."]) {
      expect(parseAttachCommand(s)).toBeNull();
    }
  });

  test("leading content before a valid command", () => {
    for (const s of ["ok &12", "> &12", "-# &recent", "x&clear"]) {
      expect(parseAttachCommand(s)).toBeNull();
    }
  });

  test("two commands in one message", () => {
    expect(parseAttachCommand("&12\n&13")).toBeNull();
    expect(parseAttachCommand("&12 &13")).toBeNull();
    expect(parseAttachCommand("&recent\n&clear")).toBeNull();
  });

  test("a space after the '&'", () => {
    for (const s of ["& 12", "& recent", "& clear", "&\t12", "& 12"]) {
      expect(parseAttachCommand(s)).toBeNull();
    }
  });

  test("doubled or stray sigils", () => {
    for (const s of ["&&12", "&&recent", "&&", "&&&", "&#12#", "&##12", "#&12", "@&12"]) {
      expect(parseAttachCommand(s)).toBeNull();
    }
  });

  test("refs with trailing junk", () => {
    for (const s of ["&12abc", "&12a", "&12-1", "&12_1", "&12/1", "&12:1", "&12!"]) {
      expect(parseAttachCommand(s)).toBeNull();
    }
  });

  test("near-miss keywords", () => {
    for (const s of ["&recents", "&recen", "&recent1", "&cleared", "&clea", "&latest", "&all"]) {
      expect(parseAttachCommand(s)).toBeNull();
    }
  });

  test("non-numeric or signed refs", () => {
    for (const s of ["&abc", "&-1", "&+1", "&1e3", "&0x1", "&١٢"]) {
      expect(parseAttachCommand(s)).toBeNull();
    }
  });
});

describe("parseAttachCommand — malformed refs", () => {
  test("leading zeros are a typo, not a ref", () => {
    for (const s of ["&012", "&00", "&0012", "&#012", "&1.02", "&01.2"]) {
      expect(parseAttachCommand(s)).toBeNull();
    }
  });

  test("a trailing or doubled dot", () => {
    for (const s of ["&12.", "&12..", "&12..1", "&.12", "&.", "&12.1."]) {
      expect(parseAttachCommand(s)).toBeNull();
    }
  });

  test("more than four dotted segments", () => {
    expect(parseAttachCommand("&1.2.3.4.5")).toBeNull();
    expect(parseAttachCommand("&1.2.3.4.5.6")).toBeNull();
  });
});

describe("parseAttachCommand — result shape", () => {
  test("the discriminant narrows to the ref for task attaches", () => {
    const cmd = parseAttachCommand("&#7.2");
    expect(cmd).not.toBeNull();
    if (cmd?.kind === "task") {
      expect(cmd.ref).toBe("7.2");
      expect(cmd.ref.startsWith("#")).toBe(false);
    } else {
      throw new Error(`expected a task attach, got ${JSON.stringify(cmd)}`);
    }
  });

  test("recent and clear carry no payload", () => {
    expect(Object.keys(parseAttachCommand("&recent")!)).toEqual(["kind"]);
    expect(Object.keys(parseAttachCommand("&clear")!)).toEqual(["kind"]);
  });
});
