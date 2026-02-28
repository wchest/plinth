'use strict';

const SHORTHAND_PROPERTIES = new Set([
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
  'transition',
  'flex',
  'grid-template',
]);

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

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
  if (!plan.siteId || typeof plan.siteId !== 'string' || plan.siteId.trim() === '') {
    throw new ValidationError('BuildPlan.siteId is required and must be a non-empty string');
  }

  // tree
  if (!plan.tree || typeof plan.tree !== 'object' || Array.isArray(plan.tree)) {
    throw new ValidationError('BuildPlan.tree is required and must be an object');
  }

  if (plan.tree.type !== 'Section') {
    throw new ValidationError(
      `BuildPlan.tree.type must be "Section", got ${JSON.stringify(plan.tree.type)}`
    );
  }

  // Walk the tree, collecting validation errors
  walkNode(plan.tree, [], 0);

  return plan;
}

function walkNode(node, ancestorTypes, depth) {
  if (depth > 6) {
    throw new ValidationError(
      `BuildPlan nesting depth exceeds the maximum of 6 levels`
    );
  }

  if (!node || typeof node !== 'object') {
    throw new ValidationError('Tree node must be an object');
  }

  // className — if present, must be kebab-case
  if (node.className !== undefined && node.className !== null) {
    if (typeof node.className !== 'string') {
      throw new ValidationError(
        `Node className must be a string, got ${typeof node.className}`
      );
    }
    if (node.className !== '' && !KEBAB_CASE_RE.test(node.className)) {
      throw new ValidationError(
        `Node className "${node.className}" must be kebab-case (e.g. "hero-section")`
      );
    }
  }

  // styles — check for shorthand CSS properties
  if (node.styles && typeof node.styles === 'object') {
    for (const key of Object.keys(node.styles)) {
      if (SHORTHAND_PROPERTIES.has(key)) {
        throw new ValidationError(
          `Shorthand CSS property "${key}" is not allowed. Use longhand properties instead.`
        );
      }
    }
  }

  const type = node.type;

  // Heading level validation
  if (type === 'Heading') {
    const level = node.level;
    if (!Number.isInteger(level) || level < 1 || level > 6) {
      throw new ValidationError(
        `Heading node requires a level between 1 and 6, got ${JSON.stringify(level)}`
      );
    }
  }

  // Link href validation
  if (type === 'Link') {
    if (!node.href || typeof node.href !== 'string' || node.href.trim() === '') {
      throw new ValidationError('Link node requires a non-empty "href" string');
    }
  }

  // Image src and alt validation
  if (type === 'Image') {
    if (!node.src || typeof node.src !== 'string' || node.src.trim() === '') {
      throw new ValidationError('Image node requires a non-empty "src" string');
    }
    if (node.alt === undefined || node.alt === null || typeof node.alt !== 'string') {
      throw new ValidationError(
        'Image node requires an "alt" string (use empty string "" for decorative images)'
      );
    }
  }

  // Recurse into children
  if (node.children) {
    if (!Array.isArray(node.children)) {
      throw new ValidationError('Node "children" must be an array');
    }
    for (const child of node.children) {
      walkNode(child, [...ancestorTypes, type], depth + 1);
    }
  }
}

module.exports = { validateBuildPlan, ValidationError };
