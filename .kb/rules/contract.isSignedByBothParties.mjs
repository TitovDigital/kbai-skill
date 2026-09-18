/**
 * Rule: contract.isSignedByBothParties.
 *
 * @author Pavel Titov
 * @copyright 2024-2026 Able Digital Ltd
 * @license Business Source License 1.1 (see LICENSE)
 */

export default async function(infer) {
    const signedByA = await infer('contract.signedByPartyA');
    const signedByB = await infer('contract.signedByPartyB');
    return signedByA && signedByB;
}
