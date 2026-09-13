/**
 * Rule: contract.isValid.
 *
 * @author Pavel Titov
 * @copyright 2024-2026 Pavel Titov
 */

export default async function(infer) {
    const hasNonCompete = await infer('contract.hasNonCompete');
    const isSignedByBoth = await infer('contract.isSignedByBothParties');
    return hasNonCompete && isSignedByBoth;
}
