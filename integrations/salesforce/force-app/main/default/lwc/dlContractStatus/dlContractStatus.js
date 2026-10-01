/**
 * draftLegal: Contract status — on a draftLegal Contract record: the stage
 * path, whose turn it is ("Waiting on: Legal (Priya)"), approvals so far, key
 * terms, and a way into draftLegal. Read from draftLegal live, so it is current
 * even between syncs.
 */
import { LightningElement, api } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import contractStatus from '@salesforce/apex/DraftLegalApi.contractStatus';

/** A key term's value as a rep reads it. */
export function formatValue(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'number') return value.toLocaleString();
    if (Array.isArray(value)) return value.map((v) => (v && v.name) || String(v)).join(', ');
    if (typeof value === 'object') {
        if ('amount' in value) return `${Number(value.amount).toLocaleString()} ${value.currency || ''}`.trim();
        if ('value' in value && 'unit' in value) return `${value.value} ${value.unit}`;
        return JSON.stringify(value);
    }
    return String(value);
}

export default class DlContractStatus extends NavigationMixin(LightningElement) {
    @api recordId;
    status;
    error;
    loading = true;

    connectedCallback() {
        this.load();
    }

    async load() {
        this.loading = true;
        this.error = undefined;
        try {
            this.status = await contractStatus({ recordId: this.recordId });
        } catch (e) {
            this.error = (e && e.body && e.body.message) || 'Could not reach draftLegal.';
        } finally {
            this.loading = false;
        }
    }

    get stages() {
        return (this.status && this.status.stages) || [];
    }

    get approvalsText() {
        const a = this.status && this.status.approvals;
        return a ? `${a.approved} of ${a.total} approved` : null;
    }

    get keyTerms() {
        const terms = (this.status && this.status.keyTerms) || [];
        return terms.map((t) => ({ key: t.key, label: t.label, value: formatValue(t.value) }));
    }

    get hasKeyTerms() {
        return this.keyTerms.length > 0;
    }

    open() {
        this[NavigationMixin.Navigate]({ type: 'standard__webPage', attributes: { url: this.status.link } });
    }
}
