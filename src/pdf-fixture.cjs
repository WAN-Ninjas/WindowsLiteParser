'use strict';

function pdfFixture(lines = ['Vendor: Acme Supplies', 'Invoice Number: INV-100', 'Invoice Date: 2026-10-15', 'Total: $125.00']) {
  const escape = value => value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT /F1 16 Tf 50 750 Td ${lines.map((line, index) => `${index ? '0 -26 Td ' : ''}(${escape(line)}) Tj`).join('\n')} ET`;
  return pdfFromStream(stream);
}

// Synthetic layout fixture: independent columns, spaced table rows, repeated values.
function invoiceFixture() {
  const lines = [];
  const at = (x, y, text, size = 10) => lines.push(`BT /F1 ${size} Tf ${x} ${792 - y} Td (${text}) Tj ET`);
  at(425, 60, 'Example Supply LLC', 18);
  at(425, 80, '123 Example Street', 9);
  at(425, 94, 'billing@example.com', 9);
  at(30, 145, 'INVOICE', 32);
  at(30, 170, '#INV-EXAMPLE-42');
  at(30, 188, 'Date: October 15, 2026');
  at(30, 202, 'Due:');
  at(410, 145, 'BILL TO', 8);
  at(410, 162, 'Example Customer', 11);
  at(410, 177, 'customer@example.org', 9);
  const columns = [38, 130, 465, 535];
  ['DATE', 'DESCRIPTION', 'QTY', 'AMOUNT'].forEach((value, index) => at(columns[index], 242, value, 9));
  for (let row = 0; row < 10; row++) {
    ['10/15/2026', 'Example service', '1', '$10.00'].forEach((value, index) => at(columns[index], 270 + row * 24, value));
  }
  at(445, 550, 'Total: $100.00', 14);
  at(30, 600, 'Terms & Conditions', 11);
  at(30, 617, 'Payment due upon receipt', 9);
  return pdfFromStream(lines.join('\n'));
}

function pdfFromStream(stream) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let output = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const start = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(output);
}

module.exports = { pdfFixture, invoiceFixture };
