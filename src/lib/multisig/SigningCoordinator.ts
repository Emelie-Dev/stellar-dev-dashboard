export class SigningCoordinator {
  signers: unknown[];

  constructor() {
    this.signers = [];
  }

  addSigner(s: unknown) {
    this.signers.push(s);
  }
}
