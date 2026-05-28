import { xdr } from '@stellar/stellar-sdk';

export interface ScValType {
  type: 'int' | 'bool' | 'string' | 'address' | 'bytes' | 'vec' | 'map';
  value: any;
}

export class WASMProcessor {
  static async parseFile(file) {
    return new Uint8Array(await file.arrayBuffer());
  }
  static toScVal(value, type) {
    if (type === 'int') return xdr.ScVal.scvI64(xdr.Int64.fromString(String(value || '0')));
    if (type === 'bool') return xdr.ScVal.scvBool(value === 'true');
    return xdr.ScVal.scvString(String(value ?? ''));
  }
}
