/**
 * executor.ts
 * Orchestrates the full BuildPlan execution pipeline:
 *   validate → create styles → build element tree → return result
 */

import { validate, ValidationError } from './validator';
import { createStyles } from './style-manager';
import { buildTree } from './element-factory';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a map of styleId → styleName for all styles on the site. */
async function buildStyleNameMap(): Promise<Map<string, string>> {
  const allStyles = await webflow.getAllStyles().catch(() => [] as Style[]);
  const styleNames = new Map<string, string>();
  try {
    const names = await Promise.all(allStyles.map((s) => s.getName()));
    allStyles.forEach((s, i) => styleNames.set(s.id, names[i]));
  } catch { /* proceed with empty map */ }
  return styleNames;
}

/**
 * Find the first Section element whose applied styles include `className`.
 * Returns null if not found.
 */
async function findSectionByClass(
  className: string,
  styleNames: Map<string, string>,
): Promise<AnyElement | null> {
  const allElements = await webflow.getAllElements().catch(() => [] as AnyElement[]);
  const sections = allElements.filter((el) => el.type === 'Section');
  for (const section of sections) {
    if (!('styles' in section) || (section as any).styles !== true) continue;
    try {
      const applied = await (section as any).getStyles() as Array<{ id: string }> | null;
      if (!applied) continue;
      const classes = applied
        .filter(Boolean)
        .map((s: { id: string }) => styleNames.get(s.id) ?? '')
        .filter(Boolean);
      if (classes.includes(className)) return section;
    } catch { continue; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildResult {
  success: boolean;
  elementsCreated: number;
  stylesCreated: number;
  stylesSkipped: number;
  elapsedMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failResult(
  error: string,
  startTime: number,
  partial?: Partial<Pick<BuildResult, 'stylesCreated' | 'stylesSkipped' | 'elementsCreated'>>,
): BuildResult {
  return {
    success: false,
    elementsCreated: partial?.elementsCreated ?? 0,
    stylesCreated: partial?.stylesCreated ?? 0,
    stylesSkipped: partial?.stylesSkipped ?? 0,
    elapsedMs: Date.now() - startTime,
    error,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes a BuildPlan end-to-end.
 *
 * 1. Validates the raw JSON input.
 * 2. Resolves the insertion point — from insertAfterElementId (headless) or
 *    the currently selected element (legacy fallback).
 * 3. Creates all styles defined in the plan.
 * 4. Recursively builds the element tree.
 * 5. Returns a BuildResult with counts and elapsed time.
 *
 * All errors are caught and reflected in the returned BuildResult; the
 * function itself never throws.
 *
 * @param planJson   Raw (unknown) BuildPlan JSON — typically parsed from a
 *                   CMS field or queue message.
 * @param onProgress Optional callback for incremental progress messages,
 *                   suitable for streaming to a UI panel.
 */
export async function executeBuildPlan(
  planJson: unknown,
  onProgress?: (msg: string) => void,
): Promise<BuildResult> {
  const startTime = Date.now();

  // ------------------------------------------------------------------
  // Step 1: Validate
  // ------------------------------------------------------------------
  onProgress?.('[executor] Validating BuildPlan…');

  let plan;
  try {
    plan = validate(planJson);
  } catch (err) {
    const message =
      err instanceof ValidationError
        ? err.message
        : `Unexpected validation error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[executor] Validation failed: ${message}`);
    onProgress?.(`[executor] Validation failed: ${message}`);
    return failResult(message, startTime);
  }

  onProgress?.(
    `[executor] Valid BuildPlan — section "${plan.sectionName}", ` +
    `${plan.styles?.length ?? 0} styles`,
  );

  // ------------------------------------------------------------------
  // Step 2: Resolve insertion point
  // ------------------------------------------------------------------
  let selectedEl: AnyElement | null = null;
  let upsertStyles = false;
  try {
    if (plan.replacesSectionClass) {
      // Atomic replace: find the existing section, capture its preceding root
      // sibling as the insertion anchor, then remove it.
      upsertStyles = true;
      const styleNames = await buildStyleNameMap();
      const targetSection = await findSectionByClass(plan.replacesSectionClass, styleNames);

      if (targetSection) {
        // Find the previous root-level sibling to use as the insertion anchor.
        try {
          const root = await webflow.getRootElement();
          if (root) {
            const rootChildren = await (root as DOMElement).getChildren()
              .catch(() => [] as AnyElement[]);
            const idx = rootChildren.findIndex(
              (el) => el.id?.element === (targetSection as any).id?.element,
            );
            if (idx > 0) {
              selectedEl = rootChildren[idx - 1];
              onProgress?.(
                `[executor] Anchor: section at position ${idx - 1} (before "${plan.replacesSectionClass}")`,
              );
            }
          }
        } catch { /* no anchor — will append to root */ }
        await (targetSection as any).remove();
        onProgress?.(`[executor] Removed existing section with class "${plan.replacesSectionClass}"`);
      } else {
        onProgress?.(
          `[executor] Warning: no section with class "${plan.replacesSectionClass}" found — building fresh`,
        );
      }
    } else if (plan.insertAfterSectionClass) {
      // Find the named section and use it as the insertion anchor.
      const styleNames = await buildStyleNameMap();
      const target = await findSectionByClass(plan.insertAfterSectionClass, styleNames);
      if (target) {
        selectedEl = target;
        onProgress?.(`[executor] Insertion point: after section with class "${plan.insertAfterSectionClass}"`);
      } else {
        onProgress?.(
          `[executor] Warning: no section with class "${plan.insertAfterSectionClass}" found ` +
          '— falling back to page root.',
        );
      }
    } else if (plan.insertAfterElementId) {
      // Deterministic: look up by element ID — no selection dependency.
      const allElements = await webflow.getAllElements().catch(() => [] as AnyElement[]);
      const target = allElements.find(
        (el) => (el.id as { element?: string })?.element === plan.insertAfterElementId,
      ) ?? null;
      if (target) {
        selectedEl = target;
        onProgress?.(`[executor] Insertion point: element ${plan.insertAfterElementId}`);
      } else {
        onProgress?.(
          `[executor] Warning: insertAfterElementId "${plan.insertAfterElementId}" not found ` +
          '— falling back to page root.',
        );
      }
    } else {
      // Legacy: use the element currently selected in the Designer.
      selectedEl = await webflow.getSelectedElement();
      if (selectedEl) {
        onProgress?.('[executor] Insertion point: selected element in Designer');
      } else {
        onProgress?.(
          '[executor] No element selected — section will be appended to page root.',
        );
      }
    }
  } catch (err) {
    // Non-fatal: proceed without an insertion point.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[executor] Could not resolve insertion point: ${message}`);
    onProgress?.(`[executor] Warning: could not resolve insertion point — ${message}`);
  }

  // ------------------------------------------------------------------
  // Step 3: Create styles
  // ------------------------------------------------------------------
  let stylesCreated = 0;
  let stylesSkipped = 0;

  try {
    onProgress?.('[executor] Creating styles…');
    const styleResult = await createStyles(plan.styles ?? [], onProgress, upsertStyles);
    stylesCreated = styleResult.created;
    stylesSkipped = styleResult.skipped;
    onProgress?.(
      `[executor] Styles done — ${stylesCreated} created, ${stylesSkipped} skipped`,
    );
  } catch (err) {
    // Unexpected error from createStyles (individual style errors are handled
    // inside createStyles itself and should not propagate here).
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[executor] Style creation failed unexpectedly: ${message}`);
    onProgress?.(`[executor] Style creation error: ${message}`);
    return failResult(message, startTime, { stylesCreated, stylesSkipped });
  }

  // ------------------------------------------------------------------
  // Step 4: Build element tree
  // ------------------------------------------------------------------
  let elementsCreated = 0;

  try {
    onProgress?.('[executor] Building element tree…');
    const treeResult = await buildTree(plan.tree, selectedEl, 0, onProgress);
    elementsCreated = treeResult.count;
    onProgress?.(`[executor] Tree built — ${elementsCreated} element(s) created`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[executor] Element tree build failed: ${message}`);
    onProgress?.(`[executor] Element build error: ${message}`);
    return failResult(message, startTime, { stylesCreated, stylesSkipped, elementsCreated });
  }

  // ------------------------------------------------------------------
  // Step 5: Return success result
  // ------------------------------------------------------------------
  const elapsedMs = Date.now() - startTime;
  onProgress?.(
    `[executor] Done in ${elapsedMs}ms — ` +
    `${elementsCreated} element(s), ${stylesCreated} style(s) created`,
  );

  return {
    success: true,
    elementsCreated,
    stylesCreated,
    stylesSkipped,
    elapsedMs,
  };
}
