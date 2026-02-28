/**
 * style-manager.ts
 * Creates Webflow styles from BuildPlan StyleDef definitions.
 * Skips styles that already exist; logs per-style errors without crashing.
 */

import type { StyleDef } from './validator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StyleResult {
  created: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Iterates over a list of StyleDef objects and applies them to the Webflow
 * canvas via the Designer API.
 *
 * - If a style with the same name already exists it is skipped (not updated).
 * - Errors on individual styles are caught, logged, and execution continues.
 *
 * @param styles     Array of style definitions from a validated BuildPlan.
 * @param onProgress Optional callback to receive human-readable progress messages.
 * @returns          Counts of created and skipped styles.
 */
export async function createStyles(
  styles: StyleDef[],
  onProgress?: (msg: string) => void,
): Promise<StyleResult> {
  let created = 0;
  let skipped = 0;

  for (const styleDef of styles) {
    try {
      // Check whether the style already exists to avoid duplicates.
      const existing = await webflow.getStyleByName(styleDef.name);
      if (existing) {
        onProgress?.(`[styles] Skipping "${styleDef.name}" — already exists`);
        skipped++;
        continue;
      }

      // Create the style.
      const style = await webflow.createStyle(styleDef.name);
      onProgress?.(`[styles] Created "${styleDef.name}"`);

      // Apply default (main breakpoint) properties.
      if (Object.keys(styleDef.properties).length > 0) {
        await style.setProperties(styleDef.properties);
      }

      // Apply breakpoint-specific properties.
      if (styleDef.breakpoints) {
        for (const [breakpointId, bpProps] of Object.entries(styleDef.breakpoints)) {
          if (bpProps && Object.keys(bpProps).length > 0) {
            await style.setProperties(bpProps, { breakpoint: breakpointId as BreakpointId });
            onProgress?.(`[styles] Applied breakpoint "${breakpointId}" to "${styleDef.name}"`);
          }
        }
      }

      // Apply pseudo-state properties.
      if (styleDef.pseudo) {
        for (const [pseudoState, pseudoProps] of Object.entries(styleDef.pseudo)) {
          if (pseudoProps && Object.keys(pseudoProps).length > 0) {
            await style.setProperties(pseudoProps, { pseudo: pseudoState as PseudoStateKey });
            onProgress?.(`[styles] Applied pseudo "${pseudoState}" to "${styleDef.name}"`);
          }
        }
      }

      created++;
    } catch (err) {
      // Log the error but continue processing remaining styles.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[style-manager] Failed to create style "${styleDef.name}": ${message}`);
      onProgress?.(`[styles] ERROR on "${styleDef.name}": ${message}`);
    }
  }

  onProgress?.(`[styles] Done — ${created} created, ${skipped} skipped`);
  return { created, skipped };
}
