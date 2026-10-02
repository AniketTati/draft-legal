import { describe, it, expect } from 'vitest'
import { detectLanguage } from './language.js'

const EN = 'This Agreement is entered into by and between the parties. The Supplier shall provide the Services described in Schedule 1, and the Customer shall pay the fees within thirty days of any invoice. Neither party will assign this agreement without the consent of the other, which shall not be unreasonably withheld.'
const FR = 'Le présent contrat est conclu entre les parties. Le prestataire fournit les services décrits dans l’annexe 1 et le client paie les honoraires dans les trente jours suivant la réception de la facture. Aucune des parties ne peut céder le contrat sans l’accord écrit de l’autre partie, qui ne peut être refusé sans motif.'
const DE = 'Dieser Vertrag wird zwischen den Parteien geschlossen. Der Auftragnehmer erbringt die in Anlage 1 beschriebenen Leistungen, und der Auftraggeber zahlt die Vergütung innerhalb von dreißig Tagen nach Erhalt der Rechnung. Keine Partei darf diesen Vertrag ohne die schriftliche Zustimmung der anderen Partei übertragen, die nicht unbillig verweigert werden darf.'
const ES = 'El presente contrato se celebra entre las partes. El proveedor prestará los servicios descritos en el anexo 1 y el cliente pagará los honorarios dentro de los treinta días siguientes a la recepción de la factura. Ninguna de las partes podrá ceder el contrato sin el consentimiento por escrito de la otra parte, que no podrá denegarse sin motivo.'

describe('detectLanguage (docs/39 A11)', () => {
  it('tells a contract’s language by its commonest words', () => {
    expect(detectLanguage(EN)?.code).toBe('en')
    expect(detectLanguage(FR)).toEqual({ code: 'fr', name: 'French' })
    expect(detectLanguage(DE)?.code).toBe('de')
    expect(detectLanguage(ES)?.code).toBe('es')
  })

  it('says nothing about a few words, or words that are only names and numbers', () => {
    expect(detectLanguage('Fees: USD 12,500 per month')).toBeNull()
    const schedule = Array.from({ length: 40 }, (_, i) => `Widget${i} Acme GmbH SKU-${i} 12.500 EUR`).join(' ')
    expect(detectLanguage(schedule)).toBeNull()
  })

  it('reads a side-by-side bilingual contract as the language it has more of', () => {
    expect(detectLanguage(`${EN} ${EN} ${DE}`)?.code).toBe('en')
  })
})
