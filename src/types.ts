export type Mode = 'sentence' | 'paragraph' | 'manuscript';
export type Kind = 'structure' | 'issue' | 'strength';
export type Severity = 'info' | 'minor' | 'major';

/** A block of input before segmentation. */
export interface RawBlock {
  kind: 'heading' | 'paragraph';
  level?: number; // heading level 1–6
  text: string;
}

export interface Sentence {
  id: string; // P3.S2
  text: string;
  /** Offsets of this sentence within its paragraph's text. */
  start: number;
  end: number;
}

export interface Paragraph {
  kind: 'paragraph';
  id: string; // P3
  text: string;
  sentences: Sentence[];
  section: string; // nearest preceding heading text, or ''
}

export interface Heading {
  kind: 'heading';
  level: number;
  text: string;
}

export type Block = Paragraph | Heading;

export interface SegmentedDoc {
  blocks: Block[];
  paragraphs: Paragraph[];
  byId: Map<string, Paragraph | Sentence>;
  /** Sentence id → paragraph */
  parentOf: Map<string, Paragraph>;
}

/** Annotation as returned by the model. */
export interface RawAnnotation {
  target_id: string;
  quote: string;
  category: string;
  kind: Kind;
  severity: Severity;
  diagnosis: string;
  why_it_matters: string;
  suggestion: string;
  links: string[];
}

/** Annotation after the app has located it in the text. */
export interface Annotation extends RawAnnotation {
  uid: number;
  paragraphId: string | null;
  /** Character offsets within the paragraph's text. null when unanchored. */
  start: number | null;
  end: number | null;
  anchorMethod: 'exact' | 'normalised' | 'fuzzy' | 'whole' | 'relocated' | 'none';
  hidden?: boolean;
}

export interface Aim {
  id: string;
  text: string;
  target_id: string;
}

export interface CoverageEntry {
  aim_id: string;
  section: string;
  status: 'addressed' | 'partial' | 'absent';
}

export interface ManuscriptSummary {
  aims: Aim[];
  coverage: CoverageEntry[];
  priorities: string[];
}

export interface ParagraphTopic {
  paragraph_id: string;
  label: string;
}

export interface AnalysisResult {
  mode: Mode;
  annotations: Annotation[];
  topics: ParagraphTopic[];
  summary: ManuscriptSummary | null;
  warnings: string[];
  usage: { input: number; output: number; cost: number | null };
}
