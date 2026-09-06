"""Negative regression cases for the implementation approval gate."""
import copy
import unittest
from pathlib import Path
from validate_documentation import validate

ROOT = Path(__file__).resolve().parents[1]


class ApprovalGateTests(unittest.TestCase):
    def setUp(self):
        self.req = {'baseline_status': 'approved', 'requirements': [
            {'id': 'R-1', 'statement': 'Deny unauthorized access.', 'priority': 'Must',
             'release': 'R1', 'status': 'approved', 'parent': None, 'source_doc': 'NFR.md'}]}
        self.trace = {
            'acceptance_criteria': [{'id': 'AC-1', 'criterion': 'A denied request reveals no data.',
                                    'requirements': ['R-1'], 'tests': ['SEC-1'], 'priority': 'P0'}],
            'stories': [{'id': 'S-1', 'requirements': ['R-1'], 'acceptance_criteria': ['AC-1']}],
            'tests': [{'id': 'SEC-1', 'status': 'planned', 'acceptance_criteria': ['AC-1'],
                       'specification': 'docs/05-quality/TEST_STRATEGY.md',
                       'behavior': 'Unauthorized requests expose no protected fields.', 'evidence': []}],
        }

    def errors(self):
        return validate(self.req, self.trace, ROOT)[0]

    def test_complete_contract_can_have_explicitly_planned_tests(self):
        self.assertEqual(self.errors(), [])

    def test_approved_baseline_rejects_missing_must_coverage(self):
        self.req['requirements'].append({**self.req['requirements'][0], 'id': 'R-2'})
        self.assertTrue(any('R-2' in e and 'lack direct' in e for e in self.errors()))

    def test_draft_coverage_gap_is_warning(self):
        self.req['baseline_status'] = 'draft'
        self.req['requirements'].append({**self.req['requirements'][0], 'id': 'R-2'})
        errors, warnings = validate(self.req, self.trace, ROOT)
        self.assertEqual(errors, [])
        self.assertTrue(warnings)

    def test_unknown_test_fails(self):
        self.trace['acceptance_criteria'][0]['tests'] = ['SEC-MISSING']
        self.assertTrue(any('unknown tests reference' in e for e in self.errors()))

    def test_empty_test_list_fails(self):
        self.trace['acceptance_criteria'][0]['tests'] = []
        self.assertTrue(any('tests is empty' in e for e in self.errors()))

    def test_unowned_critical_criterion_fails(self):
        ac = copy.deepcopy(self.trace['acceptance_criteria'][0])
        ac['id'] = 'AC-2'
        self.trace['acceptance_criteria'].append(ac)
        self.assertTrue(any('AC-2: P0 criterion has no owning story' in e for e in self.errors()))

    def test_story_requires_its_own_coverage(self):
        self.req['requirements'].append({**self.req['requirements'][0], 'id': 'R-2'})
        self.trace['stories'][0]['requirements'].append('R-2')
        self.assertTrue(any('S-1: requirement R-2' in e for e in self.errors()))

    def test_implemented_test_requires_evidence(self):
        self.trace['tests'][0]['status'] = 'implemented'
        self.assertTrue(any('implemented test has no evidence' in e for e in self.errors()))

    def test_missing_source_document_fails(self):
        self.req['requirements'][0]['source_doc'] = 'missing.md'
        self.assertTrue(any('missing or ambiguous source document' in e for e in self.errors()))

    def test_cyclic_ancestry_fails(self):
        self.req['requirements'][0]['parent'] = 'R-1'
        self.assertTrue(any('cyclic requirement ancestry' in e for e in self.errors()))

    def test_malformed_entry_reports_error(self):
        self.trace['tests'].append(None)
        self.assertTrue(any('Invalid tests entry' in e for e in self.errors()))

    def test_approval_requires_approved_requirement_status(self):
        self.req['requirements'][0]['status'] = 'draft'
        self.assertTrue(any('status must be approved' in e for e in self.errors()))


if __name__ == '__main__':
    unittest.main()
