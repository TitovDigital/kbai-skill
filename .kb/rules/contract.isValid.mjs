/**
 * Rule: contract.isValid.
 *
 * @author Pavel Titov
 * @copyright 2024-2026 Able Digital Ltd
 * @license Business Source License 1.1 (see LICENSE)
 */

export default async function(infer) {
    const hasNonCompete = await infer('contract.hasNonCompete');
    const isSignedByBoth = await infer('contract.isSignedByBothParties');
    return hasNonCompete && isSignedByBoth;
}
