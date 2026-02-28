/**
 * validator.ts
 * Validates a BuildPlan JSON object before execution.
 * Throws ValidationError with a descriptive message on any violation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ElementType =
  | 'Section'
  | 'DivBlock'
  | 'Container'
  | 'Heading'
  | 'Paragraph'
  | 'TextBlock'
  | 'Button'
  | 'TextLink'
  | 'LinkBlock'
  | 'Image'
  | 'DOM';

export type LinkType = 'url' | 'page' | 'element' | 'email' | 'phone' | 'file';

export type BreakpointId = 'xxl' | 'xl' | 'large' | 'medium' | 'small' | 'tiny';

export type PseudoState =
  | 'hover'
  | 'active'
  | 'focus'
  | 'visited'
  | 'before'
  | 'after'
  | 'first-child'
  | 'last-child'
  | 'nth-child(odd)'
  | 'nth-child(even)'
  | 'placeholder'
  | 'focus-visible'
  | 'focus-within'
  | 'empty';

export interface ElementAttribute {
  name: string;
  value: string;
}

export interface ElementNode {
  type: ElementType;
  className: string;
  text?: string;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  href?: string;
  linkType?: LinkType;
  src?: string;
  alt?: string;
  domTag?: string;
  attributes?: ElementAttribute[];
  children?: ElementNode[];
}

export interface StyleDef {
  name: string;
  parentStyle?: string;
  properties: Record<string, string>;
  breakpoints?: Partial<Record<BreakpointId, Record<string, string>>>;
  pseudo?: Partial<Record<PseudoState, Record<string, string>>>;
}

export interface BuildPlan {
  version: '1.0';
  siteId: string;
  pageId?: string;
  sectionName: string;
  order: number;
  styles?: StyleDef[];
  tree: ElementNode;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_ELEMENT_TYPES = new Set<string>([
  'Section', 'DivBlock', 'Container', 'Heading', 'Paragraph',
  'TextBlock', 'Button', 'TextLink', 'LinkBlock', 'Image', 'DOM',
]);

const TEXT_REQUIRED_TYPES = new Set<string>(['Paragraph', 'TextBlock', 'Button', 'TextLink']);
const LINK_REQUIRED_TYPES = new Set<string>(['Button', 'TextLink', 'LinkBlock']);

/**
 * Shorthand CSS properties that Webflow does not accept.
 * Webflow requires all properties to be longhand.
 */
const SHORTHAND_PROPERTIES = new Set<string>([
  'padding',
  'margin',
  'border-radius',
  'gap',
  'row-gap',
  'column-gap',
  'background',
  'font',
  'border',
  'outline',
  'list-style',
  'animation',
]);

const KEBAB_CASE_RE = /^[a-z][a-z0-9-]*$/;
const MAX_DEPTH = 6;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function assertRecord(val: unknown, label: string): Record<string, unknown> {
  if (!isRecord(val)) {
    throw new ValidationError(`${label} must be an object, got ${typeof val}`);
  }
  return val;
}

function validateCSSProperties(
  props: unknown,
  context: string,
): void {
  const map = assertRecord(props, `${context} properties`);
  for (const key of Object.keys(map)) {
    if (SHORTHAND_PROPERTIES.has(key)) {
      throw new ValidationError(
        `${context}: "${key}" is a shorthand CSS property and is not allowed. ` +
        `Use the equivalent longhand properties instead (e.g. padding-top, padding-right, ...).`,
      );
    }
    if (typeof map[key] !== 'string') {
      throw new ValidationError(
        `${context}: CSS property "${key}" must have a string value, got ${typeof map[key]}`,
      );
    }
  }
}

function validateStyleDef(style: unknown, index: number): StyleDef {
  const s = assertRecord(style, `styles[${index}]`);

  // name
  if (typeof s['name'] !== 'string' || !s['name']) {
    throw new ValidationError(`styles[${index}].name must be a non-empty string`);
  }
  const name = s['name'] as string;
  if (!KEBAB_CASE_RE.test(name)) {
    throw new ValidationError(
      `styles[${index}].name "${name}" must be kebab-case (lowercase letters, digits, hyphens; must start with a letter)`,
    );
  }

  // properties (required)
  if (!('properties' in s)) {
    throw new ValidationError(`styles[${index}] ("${name}") is missing required "properties" field`);
  }
  validateCSSProperties(s['properties'], `styles[${index}] ("${name}")`);

  // breakpoints (optional)
  if ('breakpoints' in s && s['breakpoints'] !== undefined) {
    const bp = assertRecord(s['breakpoints'], `styles[${index}] ("${name}").breakpoints`);
    for (const bpId of Object.keys(bp)) {
      validateCSSProperties(bp[bpId], `styles[${index}] ("${name}").breakpoints.${bpId}`);
    }
  }

  // pseudo (optional)
  if ('pseudo' in s && s['pseudo'] !== undefined) {
    const pseudo = assertRecord(s['pseudo'], `styles[${index}] ("${name}").pseudo`);
    for (const state of Object.keys(pseudo)) {
      validateCSSProperties(pseudo[state], `styles[${index}] ("${name}").pseudo.${state}`);
    }
  }

  return s as unknown as StyleDef;
}

function validateElementNode(
  node: unknown,
  path: string,
  depth: number,
): ElementNode {
  if (depth > MAX_DEPTH) {
    throw new ValidationError(
      `${path}: element tree exceeds maximum nesting depth of ${MAX_DEPTH} levels`,
    );
  }

  const el = assertRecord(node, path);

  // type
  if (typeof el['type'] !== 'string') {
    throw new ValidationError(`${path}.type must be a string`);
  }
  const type = el['type'] as string;
  if (!VALID_ELEMENT_TYPES.has(type)) {
    throw new ValidationError(
      `${path}.type "${type}" is not a recognised element type. ` +
      `Valid types: ${[...VALID_ELEMENT_TYPES].join(', ')}`,
    );
  }

  // className
  if (typeof el['className'] !== 'string' || !el['className']) {
    throw new ValidationError(`${path}.className must be a non-empty string`);
  }
  const className = el['className'] as string;
  if (!KEBAB_CASE_RE.test(className)) {
    throw new ValidationError(
      `${path}.className "${className}" must be kebab-case (lowercase letters, digits, hyphens; must start with a letter)`,
    );
  }

  // Heading: headingLevel required (1–6) and text required
  if (type === 'Heading') {
    if (
      typeof el['headingLevel'] !== 'number' ||
      !Number.isInteger(el['headingLevel']) ||
      (el['headingLevel'] as number) < 1 ||
      (el['headingLevel'] as number) > 6
    ) {
      throw new ValidationError(
        `${path}: Heading element requires headingLevel to be an integer between 1 and 6`,
      );
    }
    if (typeof el['text'] !== 'string' || !(el['text'] as string).trim()) {
      throw new ValidationError(
        `${path}: Heading element requires a non-empty "text" field`,
      );
    }
  }

  // Paragraph, TextBlock, Button, TextLink: text required
  if (TEXT_REQUIRED_TYPES.has(type)) {
    if (typeof el['text'] !== 'string' || !(el['text'] as string).trim()) {
      throw new ValidationError(
        `${path}: ${type} element requires a non-empty "text" field`,
      );
    }
  }

  // Button, TextLink, LinkBlock: href required
  if (LINK_REQUIRED_TYPES.has(type)) {
    if (typeof el['href'] !== 'string' || !(el['href'] as string).trim()) {
      throw new ValidationError(
        `${path}: ${type} element requires a non-empty "href" field`,
      );
    }
  }

  // Image: src and alt required
  if (type === 'Image') {
    if (typeof el['src'] !== 'string' || !(el['src'] as string).trim()) {
      throw new ValidationError(
        `${path}: Image element requires a non-empty "src" field`,
      );
    }
    if (typeof el['alt'] !== 'string') {
      throw new ValidationError(
        `${path}: Image element requires an "alt" field (may be empty string for decorative images)`,
      );
    }
  }

  // DOM: domTag required
  if (type === 'DOM') {
    if (typeof el['domTag'] !== 'string' || !(el['domTag'] as string).trim()) {
      throw new ValidationError(
        `${path}: DOM element requires a non-empty "domTag" field`,
      );
    }
  }

  // attributes (optional array)
  if ('attributes' in el && el['attributes'] !== undefined) {
    if (!Array.isArray(el['attributes'])) {
      throw new ValidationError(`${path}.attributes must be an array`);
    }
    (el['attributes'] as unknown[]).forEach((attr, i) => {
      const a = assertRecord(attr, `${path}.attributes[${i}]`);
      if (typeof a['name'] !== 'string' || !a['name']) {
        throw new ValidationError(`${path}.attributes[${i}].name must be a non-empty string`);
      }
      if (typeof a['value'] !== 'string') {
        throw new ValidationError(`${path}.attributes[${i}].value must be a string`);
      }
    });
  }

  // children (optional array) — depth increments before processing children
  if ('children' in el && el['children'] !== undefined) {
    if (!Array.isArray(el['children'])) {
      throw new ValidationError(`${path}.children must be an array`);
    }
    (el['children'] as unknown[]).forEach((child, i) => {
      validateElementNode(child, `${path}.children[${i}]`, depth + 1);
    });
  }

  return el as unknown as ElementNode;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates a raw (unknown) BuildPlan object.
 * Returns the typed BuildPlan if valid; throws ValidationError otherwise.
 */
export function validate(plan: unknown): BuildPlan {
  const p = assertRecord(plan, 'BuildPlan');

  // version
  if (p['version'] !== '1.0') {
    throw new ValidationError(
      `BuildPlan.version must be "1.0", got ${JSON.stringify(p['version'])}`,
    );
  }

  // siteId
  if (typeof p['siteId'] !== 'string' || !p['siteId'].trim()) {
    throw new ValidationError('BuildPlan.siteId must be a non-empty string');
  }

  // sectionName — kebab-case
  if (typeof p['sectionName'] !== 'string' || !p['sectionName'].trim()) {
    throw new ValidationError('BuildPlan.sectionName must be a non-empty string');
  }
  if (!KEBAB_CASE_RE.test(p['sectionName'] as string)) {
    throw new ValidationError(
      `BuildPlan.sectionName "${p['sectionName']}" must be kebab-case`,
    );
  }

  // order
  if (
    typeof p['order'] !== 'number' ||
    !Number.isInteger(p['order']) ||
    (p['order'] as number) < 1
  ) {
    throw new ValidationError('BuildPlan.order must be a positive integer');
  }

  // styles (optional)
  const styles: StyleDef[] = [];
  if ('styles' in p && p['styles'] !== undefined) {
    if (!Array.isArray(p['styles'])) {
      throw new ValidationError('BuildPlan.styles must be an array');
    }
    const seenStyleNames = new Set<string>();
    (p['styles'] as unknown[]).forEach((styleDef, i) => {
      const validated = validateStyleDef(styleDef, i);
      if (seenStyleNames.has(validated.name)) {
        throw new ValidationError(
          `BuildPlan.styles contains duplicate style name "${validated.name}"`,
        );
      }
      seenStyleNames.add(validated.name);
      styles.push(validated);
    });
  }

  // tree (required, root must be Section)
  if (!('tree' in p) || p['tree'] === undefined) {
    throw new ValidationError('BuildPlan.tree is required');
  }
  const treeRaw = assertRecord(p['tree'], 'BuildPlan.tree');
  if (treeRaw['type'] !== 'Section') {
    throw new ValidationError(
      `BuildPlan.tree.type must be "Section" (the root element must be a Section), ` +
      `got "${treeRaw['type']}"`,
    );
  }

  // Full recursive validation of the tree (Section counts as depth level 1)
  const tree = validateElementNode(p['tree'], 'tree', 1);

  return {
    version: '1.0',
    siteId: p['siteId'] as string,
    ...(p['pageId'] !== undefined ? { pageId: p['pageId'] as string } : {}),
    sectionName: p['sectionName'] as string,
    order: p['order'] as number,
    styles,
    tree,
  };
}
