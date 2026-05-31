import type { Style } from "@/pipeline/types";

export type RubricAxis = {
  name: string;
  description: string;
  scale: "1-5";
};

// Rubric for the LLM-as-judge. Fixed phrasing matters: changing these
// invalidates historical scores. Treat this file like a versioned artifact.
export const rubricVersion = "v2";

const SHARED_AXES: RubricAxis[] = [
  {
    name: "tone",
    description: "Does the script match the requested tone (conversational/formal/energetic)?",
    scale: "1-5",
  },
  {
    name: "engagement",
    description: "Is it interesting to listen to? Avoids filler, repetition, and dead air.",
    scale: "1-5",
  },
  {
    name: "coverage",
    description: "Do the selected source articles actually appear in the script?",
    scale: "1-5",
  },
];

// Style-specific axes layer on top of the shared rubric so a `deep_dive`
// isn't penalized for not covering 6 stories and a `news_roundup` isn't
// penalized for missing editorial depth.
const NEWS_ROUNDUP_AXES: RubricAxis[] = [
  {
    name: "breadth",
    description:
      "How many of the articles got a real segment (not just a name-drop)? Roundups should hit all of them.",
    scale: "1-5",
  },
];

const DEEP_DIVE_AXES: RubricAxis[] = [
  {
    name: "depth",
    description:
      "Does the script go beyond headlines into context, implications, and analysis? Deep dives reward depth.",
    scale: "1-5",
  },
];

const MAGAZINE_AXES: RubricAxis[] = [
  {
    name: "editorial-glue",
    description:
      "Are segments connected with editorial framing that links multiple articles, not just stitched together?",
    scale: "1-5",
  },
];

export function rubricForStyle(style: Style): RubricAxis[] {
  switch (style) {
    case "deep_dive":
      return [...SHARED_AXES, ...DEEP_DIVE_AXES];
    case "magazine":
      return [...SHARED_AXES, ...MAGAZINE_AXES];
    case "news_roundup":
    default:
      return [...SHARED_AXES, ...NEWS_ROUNDUP_AXES];
  }
}

// Backward-compat: existing callers that just want the shared axes.
export const scriptRubric = SHARED_AXES;
