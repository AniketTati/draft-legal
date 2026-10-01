/**
 * Tests for the draftLegal package's Apex, against a mocked draftLegal API
 * (no callout leaves the org): the launch form fills from the record, a
 * request sends the mapped fields and this org's id and is recorded on the
 * deal, locked fields ignore the rep's edits, refusals come back as
 * draftLegal's own message, and the change action sends the changed record.
 */
@IsTest
private class DraftLegalApiTest {
    /** A draftLegal that answers by path and remembers what it was sent. */
    private class FakeDraftLegal implements HttpCalloutMock {
        public List<HttpRequest> received = new List<HttpRequest>();
        public Integer failWith;

        public HttpResponse respond(HttpRequest req) {
            received.add(req);
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            if (failWith != null) {
                res.setStatusCode(failWith);
                res.setBody('{"detail":"This Salesforce org is not the one connected to this workspace"}');
                return res;
            }
            String path = req.getEndpoint().substringAfter('/integrations/salesforce');
            res.setStatusCode(200);
            if (path.startsWith('/launch-form')) {
                res.setBody(JSON.serialize(new Map<String, Object>{
                    'contractTypes' => new List<String>{ 'MSA', 'NDA' },
                    'selfServe' => path.contains('NDA'),
                    'fields' => new List<Object>{
                        new Map<String, Object>{ 'dlField' => 'value', 'label' => 'Contract value', 'type' => 'number', 'externalObject' => 'Opportunity', 'externalField' => 'Amount', 'locked' => true },
                        new Map<String, Object>{ 'dlField' => 'effectiveDate', 'label' => 'Effective date', 'type' => 'date', 'externalObject' => 'Opportunity', 'externalField' => 'CloseDate', 'locked' => false },
                        new Map<String, Object>{ 'dlField' => 'counterpartyName', 'label' => 'Counterparty', 'type' => 'text', 'externalObject' => 'Account', 'externalField' => 'Name', 'locked' => false }
                    }
                }));
            } else if (path == '/requests') {
                res.setStatusCode(201);
                res.setBody('{"requestId":"req_1","requestNumber":"REQ-20261001-001","deepLink":"https://app.draft-legal.com/requests?request=req_1","prefilled":["value"]}');
            } else if (path == '/changes') {
                res.setBody('{"contracts":[],"requests":[]}');
            } else if (path.endsWith('/status')) {
                res.setBody('{"stage":"Approve","waitingOn":"Approvers (1 of 2)","stages":["Draft","Approve","Sign"],"keyTerms":[],"link":"https://app.draft-legal.com/contracts/c1"}');
            } else if (path == '/embed-token') {
                res.setBody('{"url":"https://app.draft-legal.com/embed/contracts/c1?token=t","expiresAt":"2026-10-01T10:10:00Z"}');
            } else {
                res.setStatusCode(404);
                res.setBody('{"detail":"Not found"}');
            }
            return res;
        }

        public Map<String, Object> lastBody(String pathEnd) {
            for (Integer i = received.size() - 1; i >= 0; i--) {
                if (received[i].getEndpoint().endsWith(pathEnd)) {
                    return (Map<String, Object>) JSON.deserializeUntyped(received[i].getBody());
                }
            }
            return null;
        }
    }

    @TestSetup
    static void setup() {
        Account a = new Account(Name = 'Acme Corp');
        insert a;
        insert new Opportunity(Name = 'Acme expansion', AccountId = a.Id, StageName = 'Prospecting', CloseDate = Date.newInstance(2026, 12, 1), Amount = 40000);
        insert new DL_Contract__c(Name = 'Acme MSA', DL_Contract_Id__c = 'c1');
    }

    /** A JSON number (Integer or Decimal, as the serializer chose) as a Decimal. */
    private static Decimal num(Object o) {
        return o == null ? null : Decimal.valueOf(String.valueOf(o));
    }

    private static Opportunity opp() {
        return [SELECT Id, AccountId FROM Opportunity LIMIT 1];
    }

    @IsTest
    static void launchFormIsFilledFromTheRecord() {
        FakeDraftLegal fake = new FakeDraftLegal();
        Test.setMock(HttpCalloutMock.class, fake);
        Test.startTest();
        Map<String, Object> form = DraftLegalApi.launchForm(opp().Id, 'MSA');
        Test.stopTest();
        Map<String, Object> byField = new Map<String, Object>();
        for (Object f : (List<Object>) form.get('fields')) {
            Map<String, Object> field = (Map<String, Object>) f;
            byField.put((String) field.get('dlField'), field.get('value'));
        }
        System.assertEquals(40000, num(byField.get('value')));
        System.assertEquals('Acme Corp', byField.get('counterpartyName'));
        System.assertEquals(UserInfo.getOrganizationId(), fake.received[0].getHeader('X-Salesforce-Org-Id'));
    }

    @IsTest
    static void aRequestSendsTheMappedFieldsAndIsRecordedOnTheDeal() {
        FakeDraftLegal fake = new FakeDraftLegal();
        Test.setMock(HttpCalloutMock.class, fake);
        Opportunity o = opp();
        // The rep edits the date (editable) and the amount (locked: ignored).
        String overrides = JSON.serialize(new Map<String, Object>{ 'Opportunity.CloseDate' => '2027-01-15', 'Opportunity.Amount' => 1 });
        Test.startTest();
        Map<String, Object> res = DraftLegalApi.createRequest(o.Id, 'MSA', overrides, false);
        Test.stopTest();

        System.assertEquals('req_1', res.get('requestId'));
        Map<String, Object> sent = fake.lastBody('/requests');
        Map<String, Object> records = (Map<String, Object>) sent.get('records');
        Map<String, Object> sentOpp = (Map<String, Object>) records.get('Opportunity');
        System.assertEquals(40000, num(sentOpp.get('Amount')), 'a locked field keeps the record value');
        System.assertEquals('2027-01-15', sentOpp.get('CloseDate'));
        System.assertEquals('Acme Corp', ((Map<String, Object>) records.get('Account')).get('Name'));
        System.assertEquals(UserInfo.getUserEmail(), ((Map<String, Object>) sent.get('requestedBy')).get('email'));

        DL_Request__c row = [SELECT Name, DL_Request_Id__c, DL_Opportunity__c, DL_Account__c, DL_Link__c FROM DL_Request__c LIMIT 1];
        System.assertEquals('REQ-20261001-001', row.Name);
        System.assertEquals(o.Id, row.DL_Opportunity__c);
        System.assertEquals(o.AccountId, row.DL_Account__c);
    }

    @IsTest
    static void theFlowActionReportsARefusalInsteadOfFailingTheFlow() {
        FakeDraftLegal fake = new FakeDraftLegal();
        fake.failWith = 403;
        Test.setMock(HttpCalloutMock.class, fake);
        DraftLegalRequestAction.Input input = new DraftLegalRequestAction.Input();
        input.recordId = opp().Id;
        input.contractType = 'NDA';
        Test.startTest();
        List<DraftLegalRequestAction.Output> out = DraftLegalRequestAction.create(new List<DraftLegalRequestAction.Input>{ input });
        Test.stopTest();
        System.assertEquals(null, out[0].requestId);
        System.assert(out[0].message.contains('not the one connected'), out[0].message);
        System.assertEquals(0, [SELECT COUNT() FROM DL_Request__c]);
    }

    @IsTest
    static void theFlowActionCreatesRequests() {
        Test.setMock(HttpCalloutMock.class, new FakeDraftLegal());
        DraftLegalRequestAction.Input input = new DraftLegalRequestAction.Input();
        input.recordId = opp().Id;
        input.contractType = 'NDA';
        input.generateNow = true;
        Test.startTest();
        List<DraftLegalRequestAction.Output> out = DraftLegalRequestAction.create(new List<DraftLegalRequestAction.Input>{ input });
        Test.stopTest();
        System.assertEquals('req_1', out[0].requestId);
        System.assertEquals(1, [SELECT COUNT() FROM DL_Request__c]);
    }

    @IsTest
    static void statusAndPreviewUseTheLinkedContract() {
        FakeDraftLegal fake = new FakeDraftLegal();
        Test.setMock(HttpCalloutMock.class, fake);
        Id recordId = [SELECT Id FROM DL_Contract__c LIMIT 1].Id;
        Test.startTest();
        Map<String, Object> status = DraftLegalApi.contractStatus(recordId);
        String url = DraftLegalApi.embedUrl(recordId);
        Test.stopTest();
        System.assertEquals('Approvers (1 of 2)', status.get('waitingOn'));
        System.assert(fake.received[0].getEndpoint().endsWith('/contracts/c1/status'));
        System.assert(url.startsWith('https://app.draft-legal.com/embed/contracts/c1'));
        System.assertEquals('c1', fake.lastBody('/embed-token').get('contractId'));
    }

    @IsTest
    static void aRefusalSurfacesDraftLegalsMessage() {
        FakeDraftLegal fake = new FakeDraftLegal();
        fake.failWith = 403;
        Test.setMock(HttpCalloutMock.class, fake);
        Id recordId = [SELECT Id FROM DL_Contract__c LIMIT 1].Id;
        Test.startTest();
        try {
            DraftLegalApi.contractStatus(recordId);
            System.assert(false, 'expected a refusal');
        } catch (AuraHandledException e) {
            System.assert(true);
        }
        Test.stopTest();
    }

    @IsTest
    static void theChangeActionSendsTheChangedRecord() {
        FakeDraftLegal fake = new FakeDraftLegal();
        Test.setMock(HttpCalloutMock.class, fake);
        DraftLegalChangeAction.Input input = new DraftLegalChangeAction.Input();
        input.recordId = opp().Id;
        Test.startTest();
        DraftLegalChangeAction.notify(new List<DraftLegalChangeAction.Input>{ input });
        Test.stopTest();
        Map<String, Object> sent = fake.lastBody('/changes');
        System.assertEquals('Opportunity', sent.get('object'));
        System.assertEquals(40000, num(((Map<String, Object>) sent.get('record')).get('Amount')));
        System.assert(((Map<String, Object>) sent.get('records')).containsKey('Account'));
    }

    @IsTest
    static void overridesNeverTouchLockedOrNestedFields() {
        Map<String, Map<String, Object>> records = new Map<String, Map<String, Object>>{
            'Opportunity' => new Map<String, Object>{ 'Amount' => 10 }
        };
        List<Object> fields = new List<Object>{
            new Map<String, Object>{ 'externalObject' => 'Opportunity', 'externalField' => 'Amount', 'locked' => true },
            new Map<String, Object>{ 'externalObject' => 'Opportunity', 'externalField' => 'Account.Name', 'locked' => false },
            new Map<String, Object>{ 'externalObject' => 'Opportunity', 'externalField' => 'Description', 'locked' => false }
        };
        DraftLegalRecords.applyOverrides(records, fields, JSON.serialize(new Map<String, Object>{
            'Opportunity.Amount' => 99, 'Opportunity.Account.Name' => 'X', 'Opportunity.Description' => 'Hi'
        }));
        System.assertEquals(10, records.get('Opportunity').get('Amount'));
        System.assertEquals(null, records.get('Opportunity').get('Account.Name'));
        System.assertEquals('Hi', records.get('Opportunity').get('Description'));
        System.assertEquals('Acme', DraftLegalRecords.readPath(new Map<String, Object>{ 'Account' => new Map<String, Object>{ 'Name' => 'Acme' } }, 'Account.Name'));
    }
}
