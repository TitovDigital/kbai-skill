/**
 * Rule: contract.isSignedByBothParties.
 *
 * @author Pavel Titov
 * @copyright 2024-2026 Pavel Titov
 */

export default async function(infer) {
    const signedByA = await infer('contract.signedByPartyA');
    const signedByB = await infer('contract.signedByPartyB');
    return signedByA && signedByB;
}
