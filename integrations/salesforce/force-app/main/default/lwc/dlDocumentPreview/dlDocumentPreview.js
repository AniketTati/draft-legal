/**
 * draftLegal: Document preview — the contract's current document, framed from
 * draftLegal (read-only). The link carries a token that names this contract
 * and lasts ten minutes, so no draftLegal sign-in (or third-party cookie) is
 * needed; Refresh fetches a new one. draftLegal's address must be a Trusted URL
 * with frame-src (the package's CSP Trusted Site).
 */
import { LightningElement, api } from 'lwc';
import embedUrl from '@salesforce/apex/DraftLegalApi.embedUrl';

export default class DlDocumentPreview extends LightningElement {
    @api recordId;
    @api height = 640;
    url;
    error;

    connectedCallback() {
        this.load();
    }

    async load() {
        this.error = undefined;
        try {
            this.url = await embedUrl({ recordId: this.recordId });
        } catch (e) {
            this.url = undefined;
            this.error = (e && e.body && e.body.message) || 'Could not load the document.';
        }
    }

    get frameStyle() {
        return `width:100%;height:${Number(this.height) || 640}px;border:0;`;
    }
}
