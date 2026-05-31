export type Category = {
  name: string;
  topics: string[];
};

// Hand-curated suggestion chips for the onboarding interests step. Grouped
// for visual scanning; the user can click any chip to add it to their list.
export const SUGGESTED_INTERESTS: Category[] = [
  {
    name: "Tech",
    topics: [
      "AI policy",
      "AI research",
      "startups",
      "cybersecurity",
      "open source",
      "semiconductors",
    ],
  },
  {
    name: "Science",
    topics: [
      "space exploration",
      "climate tech",
      "biotech",
      "physics",
      "neuroscience",
    ],
  },
  {
    name: "World",
    topics: [
      "geopolitics",
      "EU politics",
      "US politics",
      "Latin America",
      "Asia-Pacific",
      "Middle East",
    ],
  },
  {
    name: "Markets",
    topics: ["macroeconomics", "stock markets", "crypto", "energy markets"],
  },
  {
    name: "Culture",
    topics: ["film", "music", "books", "sports", "F1", "soccer"],
  },
];
