/**
 * draftLegal: New contract — a native form on the Opportunity (or Quote,
 * Account). The rep picks a contract type; the form is built from draftLegal's
 * field map for that type and filled from the record. Fields the map marks
 * read-only can't be changed here. Submitting sends a request to Legal, or,
 * for a self-serve type, drafts the contract at once.
 */
import { LightningElement, api, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { CloseActionScreenEvent } from 'lightning/actions';
import { NavigationMixin } from 'lightning/navigation';
import launchForm from '@salesforce/apex/DraftLegalApi.launchForm';
import createRequest from '@salesforce/apex/DraftLegalApi.createRequest';

const INPUT_TYPE = { number: 'number', currency: 'number', percentage: 'number', date: 'date', boolean: 'checkbox' };

export function errorMessage(error) {
    return (error && error.body && error.body.message) || (error && error.message) || 'Something went wrong. Try again.';
}

/** A form field from a launch-form field: what the template needs, worked out once. */
export function toFormField(f) {
    const options = Array.isArray(f.options) ? f.options.map((o) => ({ label: o, value: o })) : null;
    return {
        key: `${f.externalObject}.${f.externalField}`,
        label: f.label,
        value: f.value === undefined ? null : f.value,
        locked: f.locked === true,
        isSelect: !!options,
        isTextarea: f.type === 'longtext',
        isCheckbox: f.type === 'boolean',
        isInput: !options && f.type !== 'longtext' && f.type !== 'boolean',
        inputType: INPUT_TYPE[f.type] || 'text',
        options,
        source: `${f.externalObject}.${f.externalField}`
    };
}

export default class DlNewContract extends NavigationMixin(LightningElement) {
    @api recordId;
    @track fields = [];
    contractTypes = [];
    contractType;
    selfServe = false;
    loading = true;
    submitting = false;
    error;
    result;
    edits = {};

    connectedCallback() {
        this.loadTypes();
    }

    async loadTypes() {
        this.loading = true;
        try {
            const form = await launchForm({ recordId: this.recordId, contractType: null });
            this.contractTypes = (form.contractTypes || []).map((t) => ({ label: t, value: t }));
        } catch (e) {
            this.error = errorMessage(e);
        } finally {
            this.loading = false;
        }
    }

    async handleType(event) {
        this.contractType = event.detail.value;
        this.result = undefined;
        this.error = undefined;
        this.edits = {};
        this.loading = true;
        try {
            const form = await launchForm({ recordId: this.recordId, contractType: this.contractType });
            this.selfServe = form.selfServe === true;
            this.fields = (form.fields || []).map(toFormField);
        } catch (e) {
            this.error = errorMessage(e);
        } finally {
            this.loading = false;
        }
    }

    handleChange(event) {
        const key = event.target.dataset.key;
        const value = event.target.type === 'checkbox' ? event.target.checked : event.detail.value;
        this.edits = { ...this.edits, [key]: value };
    }

    get hasFields() {
        return this.fields.length > 0;
    }

    get submitDisabled() {
        return !this.contractType || this.submitting || this.loading;
    }

    get submitLabel() {
        return this.selfServe ? 'Create contract' : 'Send to Legal';
    }

    async submit() {
        this.submitting = true;
        this.error = undefined;
        try {
            const res = await createRequest({
                recordId: this.recordId,
                contractType: this.contractType,
                overridesJson: JSON.stringify(this.edits),
                generateNow: this.selfServe
            });
            this.result = {
                link: res.contractLink || res.deepLink,
                text: res.contractId ? 'Your contract is being drafted.' : `Request ${res.requestNumber || ''} sent to Legal.`,
                note: res.generateRefused || null
            };
            this.dispatchEvent(new ShowToastEvent({ title: 'draftLegal', message: this.result.text, variant: 'success' }));
        } catch (e) {
            this.error = errorMessage(e);
        } finally {
            this.submitting = false;
        }
    }

    openResult(event) {
        this[NavigationMixin.Navigate]({ type: 'standard__webPage', attributes: { url: event.target.dataset.href } });
    }

    close() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }
}
