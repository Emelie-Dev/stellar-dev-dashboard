export class MultiSigTransaction {
  transaction: unknown;
  requiredSignatures: number;
  collectedSignatures: unknown[];

  constructor(transaction: unknown, requiredSignatures: number) {
    this.transaction = transaction;
    this.requiredSignatures = requiredSignatures;
    this.collectedSignatures = [];
  }

  addSignature(signature: unknown) {
    this.collectedSignatures.push(signature);
    return this.isFullySigned();
  }

  isFullySigned() {
    return this.collectedSignatures.length >= this.requiredSignatures;
  }
}
