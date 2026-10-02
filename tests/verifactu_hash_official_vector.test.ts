import assert from 'node:assert/strict';
import { calculateAltaHash } from '../src/fiscal/hashService';

const result = await calculateAltaHash({
  nifEmisor: '89890001K',
  numSerieFactura: '12345678/G33',
  fechaExpedicion: '01-01-2024',
  tipoFactura: 'F1',
  cuotaTotal: '12.35',
  importeTotal: '123.45',
  huellaAnterior: '',
  fechaHoraHusoGenRegistro: '2024-01-01T19:20:30+01:00'
});

assert.equal(
  result.canonicalString,
  'IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33&FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35&ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00'
);
assert.equal(
  result.hash,
  '3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60'
);
console.log('[PASS] vector de regresión SHA-256');
