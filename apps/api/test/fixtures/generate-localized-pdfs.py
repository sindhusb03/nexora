"""Regenerate the three authored PDFs; uses reportlab's bundled Unicode Vera font.
Run from repo root: python apps/api/test/fixtures/generate-localized-pdfs.py
No network or system-font discovery; reportlab is a generation tool, not a test dependency.
"""
from pathlib import Path
import reportlab
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

pdfmetrics.registerFont(TTFont("Vera", str(Path(reportlab.__file__).parent / "fonts" / "Vera.ttf")))
cases = [
    ("fr-sa-income", "Compte de résultat", "en milliers d'euros EUR", "Notes",
     ["1. Chiffre d’affaires", "IV. Charges de personnel", "a) Résultat net"], ["12 345,6", "(2 345,6)", "10 000"]),
    ("de-gmbh-income", "Gewinn- und Verlustrechnung", "in Tausend EUR", "Anhang",
     ["Umsatzerlöse", "Personalaufwand", "Jahresüberschuss"], ["12.345,6", "-2.345,6", "10.000,0"]),
    ("es-sl-income", "Cuenta de pérdidas y ganancias", "miles de euros EUR", "Notas",
     ["Importe neto de la cifra de negocios", "Gastos de personal", "Resultado del ejercicio"], ["12.345,6", "(2.345,6)", "10.000,0"]),
]
out = Path(__file__).parent / "localized"
out.mkdir(exist_ok=True)
for name, title, unit, note, labels, amounts in cases:
    pdf = canvas.Canvas(str(out / (name + ".pdf")), invariant=1, pageCompression=0)
    pdf.setFont("Vera", 9)
    pdf.drawString(28, 780, title)
    pdf.drawString(28, 760, unit)
    pdf.drawString(300, 740, note)
    pdf.drawString(390, 740, "Year ended")
    pdf.drawString(390, 726, "31 March 2025")
    for i, (label, amount) in enumerate(zip(labels, amounts)):
        y = 690 - i * 20
        pdf.drawString(28, y, label)
        pdf.drawString(300, y, str(71 + i))
        pdf.drawString(390, y, amount)
    pdf.save()
