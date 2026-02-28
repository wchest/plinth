/**
 * executor.ts
 * Orchestrates the full BuildPlan execution pipeline:
 *   validate → create styles → build element tree → return result
 */

import { validate, ValidationError } from './validator';
import { createStyles } from './style-manager';
import { buildTree } from './element-factory';

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
 * 2. Reads the currently selected element in the Designer as the insertion point.
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
  try {
    selectedEl = await webflow.getSelectedElement();
    if (selectedEl) {
      onProgress?.('[executor] Insertion point: selected element in Designer');
    } else {
      onProgress?.(
        '[executor] No element selected — section will be created unattached. ' +
        'Select an element before running to control placement.',
      );
    }
  } catch (err) {
    // Non-fatal: proceed without an insertion point.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[executor] Could not read selected element: ${message}`);
    onProgress?.(`[executor] Warning: could not read selected element — ${message}`);
  }

  // ------------------------------------------------------------------
  // Step 3: Create styles
  // ------------------------------------------------------------------
  let stylesCreated = 0;
  let stylesSkipped = 0;

  try {
    onProgress?.('[executor] Creating styles…');
    const styleResult = await createStyles(plan.styles ?? [], onProgress);
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
