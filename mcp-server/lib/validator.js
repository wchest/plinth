'use strict';

// ---------------------------------------------------------------------------
// Constants — kept in sync with extension/src/builder/validator.ts
// ---------------------------------------------------------------------------

const VALID_ELEMENT_TYPES = new Set([
  'Section', 'DivBlock', 'Container', 'Heading', 'Paragraph',
  'TextBlock', 'Button', 'TextLink', 'LinkBlock', 'Image', 'DOM',
  'DynamoWrapper',
]);

const TEXT_REQUIRED_TYPES = new Set(['Paragraph', 'TextBlock', 'Button', 'TextLink']);
const LINK_REQUIRED_TYPES = new Set(['Button', 'TextLink', 'LinkBlock']);

const SHORTHAND_PROPERTIES = new Set([
  'padding', 'margin', 'border-radius', 'gap', 'row-gap', 'column-gap',
  'background', 'font', 'border', 'outline', 'list-style', 'animation',
  'transition', 'flex', 'grid-template',
]);

const KEBAB_CASE_RE = /^[a-z][a-z0-9-]*$/;

// Extension counts Section as depth 1 and rejects depth > 6.
// That means Section + 5 child levels max.
const MAX_DEPTH = 6;

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateCSSProperties(props, context) {
  if (props === null || typeof props !== 'object' || Array.isArray(props)) {
    throw new ValidationError(`${context} must be an object`);
  }
  for (const key of Object.keys(props)) {
    if (SHORTHAND_PROPERTIES.has(key)) {
      throw new ValidationError(
        `${context}: "${key}" is a shorthand CSS property and is not allowed. ` +
        `Use longhand properties instead (e.g. padding-top, padding-right, ...).`
      );
    }
    if (typeof props[key] !== 'string') {
      throw new ValidationError(
        `${context}: CSS property "${key}" must have a string value, got ${typeof props[key]}`
      );
    }
  }
}

function validateStyleDef(style, index) {
  if (style === null || typeof style !== 'object' || Array.isArray(style)) {
    throw new ValidationError(`styles[${index}] must be an object`);
  }

  if (typeof style.name !== 'string' || !style.name) {
    throw new ValidationError(`styles[${index}].name must be a non-empty string`);
  }
  if (!KEBAB_CASE_RE.test(style.name)) {
    throw new ValidationError(
      `styles[${index}].name "${style.name}" must be kebab-case ` +
      `(lowercase letters, digits, hyphens; must start with a letter)`
    );
  }

  if (!('properties' in style)) {
    throw new ValidationError(
      `styles[${index}] ("${style.name}") is missing required "properties" field`
    );
  }
  validateCSSProperties(style.properties, `styles[${index}] ("${style.name}")`);

  if (style.breakpoints != null) {
    if (typeof style.breakpoints !== 'object' || Array.isArray(style.breakpoints)) {
      throw new ValidationError(`styles[${index}] ("${style.name}").breakpoints must be an object`);
    }
    for (const bpId of Object.keys(style.breakpoints)) {
      validateCSSProperties(
        style.breakpoints[bpId],
        `styles[${index}] ("${style.name}").breakpoints.${bpId}`
      );
    }
  }

  if (style.pseudo != null) {
    if (typeof style.pseudo !== 'object' || Array.isArray(style.pseudo)) {
      throw new ValidationError(`styles[${index}] ("${style.name}").pseudo must be an object`);
    }
    for (const state of Object.keys(style.pseudo)) {
      validateCSSProperties(
        style.pseudo[state],
        `styles[${index}] ("${style.name}").pseudo.${state}`
      );
    }
  }
}

function walkNode(node, path, depth) {
  // Extension: Section starts at depth 1, rejects depth > MAX_DEPTH
  if (depth > MAX_DEPTH) {
    throw new ValidationError(
      `${path}: element tree exceeds maximum nesting depth of ${MAX_DEPTH} levels`
    );
  }

  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new ValidationError(`${path} must be an object`);
  }

  // type
  if (typeof node.type !== 'string') {
    throw new ValidationError(`${path}.type must be a string`);
  }
  if (!VALID_ELEMENT_TYPES.has(node.type)) {
    throw new ValidationError(
      `${path}.type "${node.type}" is not a recognised element type. ` +
      `Valid types: ${[...VALID_ELEMENT_TYPES].join(', ')}`
    );
  }

  // className — always required, must be kebab-case
  if (typeof node.className !== 'string' || !node.className) {
    throw new ValidationError(`${path}.className must be a non-empty string`);
  }
  if (!KEBAB_CASE_RE.test(node.className)) {
    throw new ValidationError(
      `${path}.className "${node.className}" must be kebab-case ` +
      `(lowercase letters, digits, hyphens; must start with a letter)`
    );
  }

  // Heading: headingLevel (1–6) and text required
  if (node.type === 'Heading') {
    if (
      typeof node.headingLevel !== 'number' ||
      !Number.isInteger(node.headingLevel) ||
      node.headingLevel < 1 ||
      node.headingLevel > 6
    ) {
      throw new ValidationError(
        `${path}: Heading element requires headingLevel to be an integer between 1 and 6`
      );
    }
    if (typeof node.text !== 'string' || !node.text.trim()) {
      throw new ValidationError(`${path}: Heading element requires a non-empty "text" field`);
    }
  }

  // Paragraph, TextBlock, Button, TextLink: text required
  if (TEXT_REQUIRED_TYPES.has(node.type)) {
    if (typeof node.text !== 'string' || !node.text.trim()) {
      throw new ValidationError(
        `${path}: ${node.type} element requires a non-empty "text" field`
      );
    }
  }

  // Button, TextLink, LinkBlock: href required
  if (LINK_REQUIRED_TYPES.has(node.type)) {
    if (typeof node.href !== 'string' || !node.href.trim()) {
      throw new ValidationError(
        `${path}: ${node.type} element requires a non-empty "href" field`
      );
    }
  }

  // Image: src and alt required
  if (node.type === 'Image') {
    if (typeof node.src !== 'string' || !node.src.trim()) {
      throw new ValidationError(`${path}: Image element requires a non-empty "src" field`);
    }
    if (typeof node.alt !== 'string') {
      throw new ValidationError(
        `${path}: Image element requires an "alt" field (may be empty string for decorative images)`
      );
    }
  }

  // DOM: domTag required
  if (node.type === 'DOM') {
    if (typeof node.domTag !== 'string' || !node.domTag.trim()) {
      throw new ValidationError(`${path}: DOM element requires a non-empty "domTag" field`);
    }
  }

  // children
  if (node.children != null) {
    if (!Array.isArray(node.children)) {
      throw new ValidationError(`${path}.children must be an array`);
    }
    node.children.forEach((child, i) => {
      walkNode(child, `${path}.children[${i}]`, depth + 1);
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function validateBuildPlan(plan) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new ValidationError('BuildPlan must be a JSON object');
  }

  // version
  if (plan.version !== '1.0') {
    throw new ValidationError(
      `BuildPlan.version must be "1.0", got ${JSON.stringify(plan.version)}`
    );
  }

  // siteId
  if (typeof plan.siteId !== 'string' || !plan.siteId.trim()) {
    throw new ValidationError('BuildPlan.siteId must be a non-empty string');
  }

  // sectionName — kebab-case
  if (typeof plan.sectionName !== 'string' || !plan.sectionName.trim()) {
    throw new ValidationError('BuildPlan.sectionName must be a non-empty string');
  }
  if (!KEBAB_CASE_RE.test(plan.sectionName)) {
    throw new ValidationError(
      `BuildPlan.sectionName "${plan.sectionName}" must be kebab-case`
    );
  }

  // order — positive integer
  if (
    typeof plan.order !== 'number' ||
    !Number.isInteger(plan.order) ||
    plan.order < 1
  ) {
    throw new ValidationError('BuildPlan.order must be a positive integer');
  }

  // styles (optional array)
  if (plan.styles != null) {
    if (!Array.isArray(plan.styles)) {
      throw new ValidationError('BuildPlan.styles must be an array');
    }
    const seenNames = new Set();
    plan.styles.forEach((styleDef, i) => {
      validateStyleDef(styleDef, i);
      if (seenNames.has(styleDef.name)) {
        throw new ValidationError(
          `BuildPlan.styles contains duplicate style name "${styleDef.name}"`
        );
      }
      seenNames.add(styleDef.name);
    });
  }

  // insertAfterSectionClass (optional — kebab-case string)
  if (plan.insertAfterSectionClass != null) {
    if (typeof plan.insertAfterSectionClass !== 'string' || !plan.insertAfterSectionClass.trim()) {
      throw new ValidationError('BuildPlan.insertAfterSectionClass must be a non-empty string');
    }
    if (!KEBAB_CASE_RE.test(plan.insertAfterSectionClass)) {
      throw new ValidationError(
        `BuildPlan.insertAfterSectionClass "${plan.insertAfterSectionClass}" must be kebab-case`
      );
    }
  }

  // replacesSectionClass (optional — kebab-case string)
  if (plan.replacesSectionClass != null) {
    if (typeof plan.replacesSectionClass !== 'string' || !plan.replacesSectionClass.trim()) {
      throw new ValidationError('BuildPlan.replacesSectionClass must be a non-empty string');
    }
    if (!KEBAB_CASE_RE.test(plan.replacesSectionClass)) {
      throw new ValidationError(
        `BuildPlan.replacesSectionClass "${plan.replacesSectionClass}" must be kebab-case`
      );
    }
  }

  // tree — required, root must be Section
  if (plan.tree == null || typeof plan.tree !== 'object' || Array.isArray(plan.tree)) {
    throw new ValidationError('BuildPlan.tree is required and must be an object');
  }
  if (plan.tree.type !== 'Section') {
    throw new ValidationError(
      `BuildPlan.tree.type must be "Section", got ${JSON.stringify(plan.tree.type)}`
    );
  }

  // Full recursive walk — Section counts as depth 1 (matching extension)
  walkNode(plan.tree, 'tree', 1);

  return plan;
}

module.exports = { validateBuildPlan, ValidationError };
