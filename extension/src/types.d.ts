/**
 * Type augmentations for @webflow/designer-extension-typings v2.0.2.
 * createDOM is referenced in JSDoc examples but missing from the typed interface.
 */
interface WebflowApi {
  createDOM(tag: string): Promise<DOMElement>;
}
