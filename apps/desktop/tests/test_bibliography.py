from __future__ import annotations

import json
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, sentinel

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from bibliography import MAX_METADATA_REDIRECTS, MAX_METADATA_RESPONSE_BYTES, _PinnedHTTPSConnection, _candidate_is_safe, _candidate_match, _doi_exact, _exact_candidate_is_consistent, _fetch_bytes, empty_bibliographic_metadata, extract_local_metadata, retrieve_bibliographic_metadata, retrieve_reference_evidence  # noqa: E402
import bibliography as bibliography_module  # noqa: E402


class BibliographyTest(unittest.TestCase):
    def _document(self, directory: Path, *, doi: str = "10.1234/example") -> Path:
        path = directory / "document.json"
        path.write_text(json.dumps({"pages": [{"elements": [
            {"type": "title", "text": "A Unified Research Framework"},
            {"type": "paragraph", "text": "Ada Lovelace, Alan Turing"},
            {"type": "title", "text": "Abstract"},
            {"type": "paragraph", "text": f"We present a method. DOI: {doi} arXiv: 2401.01234"},
        ]}]}, ensure_ascii=False), encoding="utf-8")
        return path

    def _network_mocks(self, routes, addresses):
        opened = []

        class FakeResponse:
            def __init__(self, status, headers, body):
                self.status = status
                self.reason = "test response"
                self.headers = headers
                self.body = body

            def read(self, limit):
                if isinstance(self.body, BaseException):
                    raise self.body
                return self.body[:limit]

        class FakeConnection:
            def __init__(self, host, port, resolved_ip, *, timeout):
                self.host = host
                self.port = port
                self.resolved_ip = resolved_ip
                self.timeout = timeout
                self.path = ""

            def request(self, method, path, *, headers):
                self.path = path
                opened.append((self.host, self.resolved_ip, method, path, headers))

            def getresponse(self):
                response = routes[(self.host, self.path)]
                status, headers, body = response.pop(0) if isinstance(response, list) else response
                return FakeResponse(status, headers, body)

            def close(self):
                return None

        def resolve(host, port, *_args, **_kwargs):
            values = addresses[host]
            values = values if isinstance(values, list) else [values]
            records = []
            for address in values:
                family = socket.AF_INET6 if ":" in address else socket.AF_INET
                sockaddr = (address, port, 0, 0) if family == socket.AF_INET6 else (address, port)
                records.append((family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr))
            return records

        return (
            patch("bibliography.socket.getaddrinfo", side_effect=resolve),
            patch("bibliography._PinnedHTTPSConnection", FakeConnection),
            opened,
        )

    def test_local_extraction_finds_title_authors_and_identifiers(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            metadata = extract_local_metadata(directory / "missing.pdf", self._document(directory), "paper.pdf")
            self.assertEqual(metadata["fields"]["title"], "A Unified Research Framework")
            self.assertEqual(metadata["fields"]["authors"], ["Ada Lovelace", "Alan Turing"])
            self.assertEqual(metadata["fields"]["doi"], "10.1234/example")
            self.assertEqual(metadata["fields"]["arxiv_id"], "2401.01234")
            self.assertEqual(metadata["status"], "local")

    def test_local_extraction_uses_same_column_abstract_body_before_right_column_heading(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            document = directory / "document.json"
            clean = (
                "The number of wearable activity trackers has increased rapidly, and these devices collect "
                "sensitive behavioral and physiological data that creates substantial privacy risks."
            )
            document.write_text(json.dumps({"pages": [{"elements": [
                {"type": "title", "text": "A Step Closer to your Heart", "bbox": [53, 45, 557, 92]},
                {"type": "paragraph", "text": "Alice Example, Bob Example", "bbox": [53, 105, 557, 137]},
                {"type": "title", "text": "Abstract", "bbox": [53, 148, 95, 163], "section_role": "abstract-heading"},
                {"type": "title", "text": "Keywords", "bbox": [317, 148, 367, 163]},
                {"type": "paragraph", "text": clean, "bbox": [53, 164, 295, 320], "section_role": "abstract-body"},
                {"type": "paragraph", "text": "wearable devices, privacy, re-identification", "bbox": [317, 164, 557, 210]},
            ]}]}, ensure_ascii=False), encoding="utf-8")

            metadata = extract_local_metadata(directory / "missing.pdf", document, "paper.pdf")

            self.assertEqual(metadata["fields"]["abstract"], clean)
            self.assertEqual(metadata["sources"]["abstract"]["provider"], "local-document")

    def test_fragmented_abstract_is_rejected_without_guessing_space_repairs(self) -> None:
        fragmented = (
            "Th e num b er o f users o f weara bl e d ev i ces i n creased over th e p ast d eca d es. "
            "Th ese d ev i ces con ti nuous l y co ll ec t sens iti ve data a b ou t th e users."
        )
        clean = (
            "We evaluate WAT, AUC, LFM, and FFM under N = 230 participants and report privacy risks "
            "for wearable activity trackers without modifying the source token spacing."
        )

        self.assertTrue(bibliography_module.is_fragmented_metadata_text(fragmented))
        self.assertFalse(bibliography_module.is_fragmented_metadata_text(clean))
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            document = directory / "document.json"
            document.write_text(json.dumps({"pages": [{"elements": [
                {"type": "title", "text": "Paper Title"},
                {"type": "title", "text": "Abstract", "section_role": "abstract-heading"},
                {"type": "paragraph", "text": fragmented, "section_role": "abstract-body"},
            ]}]}), encoding="utf-8")
            metadata = extract_local_metadata(directory / "missing.pdf", document, "paper.pdf")
        self.assertEqual(metadata["fields"]["abstract"], "")

    def test_local_extraction_reads_year_from_underscore_filename(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            metadata = extract_local_metadata(directory / "missing.pdf", self._document(directory), "VLMo_NeurIPS_2022.pdf")
            self.assertEqual(metadata["fields"]["year"], 2022)
            self.assertEqual(metadata["sources"]["year"]["provider"], "filename")

    def test_exact_doi_result_is_merged_with_high_confidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            document = self._document(directory)
            crossref = {"message": {"title": ["A Unified Research Framework"], "author": [{"given": "Ada", "family": "Lovelace"}], "published": {"date-parts": [[2024]]}, "container-title": ["Journal of Tests"], "DOI": "10.1234/example", "URL": "https://doi.org/10.1234/example"}}
            with patch("bibliography._fetch_json", return_value=crossref):
                metadata = retrieve_bibliographic_metadata(directory / "missing.pdf", document, "paper.pdf", online=True)
            self.assertEqual(metadata["status"], "complete")
            self.assertEqual(metadata["fields"]["venue"], "Journal of Tests")
            self.assertEqual(metadata["sources"]["doi"]["provider"], "crossref-doi")

    def test_online_disabled_does_not_call_provider(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            with patch("bibliography._fetch_json", side_effect=AssertionError("network should be disabled")):
                metadata = retrieve_bibliographic_metadata(directory / "missing.pdf", self._document(directory), "paper.pdf", online=False)
            self.assertEqual(metadata["status"], "local")

    def test_old_style_arxiv_identifier_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            document = directory / "document.json"
            document.write_text(json.dumps({"pages": [{"elements": [
                {"type": "title", "text": "An Older Preprint"},
                {"type": "paragraph", "text": "arXiv: astro-ph/0603274v2"},
            ]}]}), encoding="utf-8")
            metadata = extract_local_metadata(directory / "missing.pdf", document, "paper.pdf")
            self.assertEqual(metadata["fields"]["arxiv_id"], "astro-ph/0603274v2")

    def test_doi_content_negotiation_maps_formal_venue(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            csl = {
                "type": "paper-conference",
                "title": "A Unified Research Framework",
                "author": [{"given": "Ada", "family": "Lovelace"}],
                "issued": {"date-parts": [[2024]]},
                "container-title": "Proceedings of TestConf",
                "event-title": "TestConf 2024",
                "DOI": "10.1234/example",
            }
            with patch("bibliography._fetch_json", return_value=csl):
                metadata = retrieve_bibliographic_metadata(directory / "missing.pdf", self._document(directory), "paper.pdf", online=True)
            self.assertEqual(metadata["fields"]["venue"], "TestConf 2024")
            self.assertEqual(metadata["fields"]["proceedings_title"], "Proceedings of TestConf")
            self.assertEqual(metadata["sources"]["doi"]["provider"], "doi-content-negotiation")

    def test_arxiv_published_doi_replaces_repository_with_formal_source(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            document = self._document(directory, doi="")
            arxiv = {"title": "A Unified Research Framework", "authors": ["Ada Lovelace"], "arxiv_id": "2401.01234", "doi": "10.5555/formal", "repository": "arXiv", "venue": "arXiv", "item_type": "posted-content"}
            formal = {"title": "A Unified Research Framework", "authors": ["Ada Lovelace"], "doi": "10.5555/formal", "conference_name": "FormalConf", "proceedings_title": "Formal Proceedings", "venue": "FormalConf", "item_type": "proceedings-article"}
            with patch("bibliography._arxiv_fields", return_value=arxiv), patch("bibliography._doi_exact", return_value=(formal, "crossref-doi")):
                metadata = retrieve_bibliographic_metadata(directory / "missing.pdf", document, "paper.pdf", online=True)
            self.assertEqual(metadata["status"], "complete")
            self.assertEqual(metadata["fields"]["venue"], "FormalConf")
            self.assertEqual(metadata["sources"]["venue"]["provider"], "crossref-doi")

    def test_failed_doi_provider_continues_to_arxiv(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            arxiv = {"title": "A Unified Research Framework", "authors": ["Ada Lovelace"], "arxiv_id": "2401.01234", "repository": "arXiv", "venue": "arXiv", "item_type": "posted-content"}
            with patch("bibliography._doi_exact", side_effect=ValueError("DOI unavailable")), patch("bibliography._arxiv_fields", return_value=arxiv):
                metadata = retrieve_bibliographic_metadata(directory / "missing.pdf", self._document(directory), "paper.pdf", online=True)
            self.assertEqual(metadata["status"], "complete")
            self.assertEqual(metadata["fields"]["venue"], "arXiv")

    def test_reference_doi_cannot_replace_the_uploaded_paper(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            document = self._document(directory)
            unrelated = {
                "title": "A Completely Different Cited Article",
                "authors": ["Other Author"],
                "doi": "10.1234/example",
                "publication_title": "Wrong Journal",
                "venue": "Wrong Journal",
                "item_type": "journal-article",
            }
            with (
                patch("bibliography._doi_exact", return_value=(unrelated, "crossref-doi")),
                patch("bibliography._arxiv_fields", side_effect=ValueError("arXiv unavailable")),
                patch("bibliography._crossref_candidates", return_value=[]),
            ):
                metadata = retrieve_bibliographic_metadata(directory / "missing.pdf", document, "paper.pdf", online=True)
            self.assertNotEqual(metadata["status"], "complete")
            self.assertNotEqual(metadata["fields"]["venue"], "Wrong Journal")
            self.assertEqual(metadata["fields"]["doi"], "")
            self.assertIn("不一致", metadata["error"])

    def test_safe_title_candidate_replaces_a_rejected_reference_doi(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            document = self._document(directory)
            unrelated = {"title": "A Completely Different Cited Article", "authors": ["Other Author"], "doi": "10.1234/example"}
            correct = {
                "title": "A Unified Research Framework",
                "authors": ["Ada Lovelace", "Alan Turing"],
                "doi": "10.9999/correct",
                "conference_name": "CorrectConf",
                "venue": "CorrectConf",
                "item_type": "proceedings-article",
            }
            candidate = {"provider": "crossref", "confidence": 0.99, "match": {"confidence": 0.99, "title": 1.0, "authors": 1.0, "year_delta": None}, "fields": correct}
            with (
                patch("bibliography._doi_exact", return_value=(unrelated, "crossref-doi")),
                patch("bibliography._arxiv_fields", side_effect=ValueError("arXiv unavailable")),
                patch("bibliography._crossref_candidates", return_value=[candidate]),
            ):
                metadata = retrieve_bibliographic_metadata(directory / "missing.pdf", document, "paper.pdf", online=True)
            self.assertEqual(metadata["status"], "complete")
            self.assertEqual(metadata["fields"]["doi"], "10.9999/correct")
            self.assertEqual(metadata["fields"]["venue"], "CorrectConf")

    def test_title_only_candidate_cannot_be_auto_accepted(self) -> None:
        self.assertFalse(_candidate_is_safe({"confidence": 0.99, "title": 1.0, "authors": 0.0, "year_delta": None}))

    def test_exact_title_year_and_persistent_identifier_can_confirm_without_authors(self) -> None:
        self.assertTrue(_candidate_is_safe({"confidence": 0.8, "title": 1.0, "authors": 0.0, "year_delta": 0, "has_identifier": True}))

    def test_affiliation_markers_do_not_break_author_subset_match(self) -> None:
        match = _candidate_match(
            {"title": "OneLLM: One Framework", "authors": ["Jiaming Han 1", "Kaixiong Gong 1"]},
            {"title": "OneLLM: One Framework", "authors": ["Jiaming Han", "Kaixiong Gong", "Another Author"]},
        )
        self.assertEqual(match["authors"], 1.0)
        self.assertTrue(_candidate_is_safe(match))

    def test_different_non_latin_titles_are_not_treated_as_identical(self) -> None:
        local = empty_bibliographic_metadata()
        local["fields"]["title"] = "面向科学推理的统一模型"
        local["sources"]["title"] = {"provider": "local-document", "confidence": 0.9}
        remote = {"title": "另一篇完全不同的医学论文", "authors": []}
        self.assertFalse(_exact_candidate_is_consistent(local, remote))

    def test_oversized_provider_response_is_rejected_before_caching(self) -> None:
        routes = {
            ("oversized.example", "/metadata"): (
                200,
                {"Content-Length": str(MAX_METADATA_RESPONSE_BYTES + 1)},
                AssertionError("oversized response should not be read"),
            ),
        }
        resolver, connection, _opened = self._network_mocks(routes, {"oversized.example": "8.8.8.8"})
        with resolver, connection:
            with self.assertRaisesRegex(ValueError, "2 MB"):
                _fetch_bytes("https://oversized.example/metadata", user_agent="test", accept="application/json")

    def test_metadata_redirect_rejects_non_public_addresses_at_later_hops(self) -> None:
        unsafe_addresses = {
            "loopback": "127.0.0.1",
            "ipv6-loopback": "::1",
            "private": "10.1.2.3",
            "link-local": "169.254.169.254",
        }
        for label, unsafe_address in unsafe_addresses.items():
            with self.subTest(label=label):
                start_path = f"/security-{label}"
                routes = {
                    ("doi.org", start_path): (302, {"Location": "https://public-hop.example/next"}, b""),
                    ("public-hop.example", "/next"): (302, {"Location": f"https://{label}.internal/metadata"}, b""),
                }
                addresses = {
                    "doi.org": "8.8.8.8",
                    "public-hop.example": "1.1.1.1",
                    f"{label}.internal": unsafe_address,
                }
                resolver, connection, opened = self._network_mocks(routes, addresses)
                with resolver, connection, self.assertRaisesRegex(ValueError, "公共网络"):
                    _fetch_bytes(
                        f"https://doi.org{start_path}",
                        user_agent="test",
                        accept="application/json",
                        retries=0,
                    )
                self.assertEqual([entry[0] for entry in opened], ["doi.org", "public-hop.example"])

    def test_metadata_rejects_mixed_public_and_private_dns_answers(self) -> None:
        records = [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("8.8.8.8", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("10.0.0.9", 443)),
        ]
        with (
            patch("bibliography.socket.getaddrinfo", return_value=records),
            patch("bibliography._PinnedHTTPSConnection", side_effect=AssertionError("mixed DNS target must not connect")),
            self.assertRaisesRegex(ValueError, "公共网络"),
        ):
            _fetch_bytes(
                "https://mixed-dns.example/metadata",
                user_agent="test",
                accept="application/json",
                retries=0,
            )

    def test_metadata_redirect_rejects_non_https_target(self) -> None:
        routes = {
            ("doi.org", "/security-http"): (302, {"Location": "http://publisher.example/metadata"}, b""),
        }
        resolver, connection, opened = self._network_mocks(routes, {"doi.org": "8.8.8.8"})
        with resolver, connection, self.assertRaisesRegex(ValueError, "仅允许 HTTPS"):
            _fetch_bytes(
                "https://doi.org/security-http",
                user_agent="test",
                accept="application/json",
                retries=0,
            )
        self.assertEqual([entry[0] for entry in opened], ["doi.org"])

    def test_metadata_redirect_limit_is_enforced(self) -> None:
        routes = {
            ("redirect.example", f"/{index}"): (
                302,
                {"Location": f"https://redirect.example/{index + 1}"},
                b"",
            )
            for index in range(MAX_METADATA_REDIRECTS + 1)
        }
        resolver, connection, opened = self._network_mocks(routes, {"redirect.example": "8.8.8.8"})
        with resolver, connection, self.assertRaisesRegex(ValueError, "重定向超过"):
            _fetch_bytes(
                "https://redirect.example/0",
                user_agent="test",
                accept="application/json",
                retries=0,
            )
        self.assertEqual(len(opened), MAX_METADATA_REDIRECTS + 1)

    def test_http_status_retry_does_not_fail_over_to_another_resolved_ip(self) -> None:
        routes = {
            ("retry-status.example", "/metadata"): [
                (429, {"Retry-After": "0.05"}, b"busy"),
                (200, {"Content-Type": "application/json"}, b'{"ok": true}'),
            ],
        }
        resolver, connection, opened = self._network_mocks(
            routes,
            {"retry-status.example": ["8.8.8.8", "1.1.1.1"]},
        )
        with resolver, connection, patch("bibliography.time.sleep") as delay:
            data = _fetch_bytes(
                "https://retry-status.example/metadata",
                user_agent="test",
                accept="application/json",
                retries=1,
            )

        self.assertEqual(data, b'{"ok": true}')
        delay.assert_called_once_with(0.05)
        self.assertEqual([entry[1] for entry in opened], ["8.8.8.8", "8.8.8.8"])

    def test_public_https_doi_redirect_preserves_content_negotiation(self) -> None:
        csl = {
            "type": "article-journal",
            "title": "A Public Redirected DOI",
            "DOI": "10.1234/public-redirect",
            "container-title": "Journal of Safe Redirects",
        }
        routes = {
            ("doi.org", "/10.1234/public-redirect"): (302, {"Location": "https://publisher.example:8443/csl"}, b""),
            ("publisher.example", "/csl"): (200, {"Content-Type": "application/json"}, json.dumps(csl).encode()),
        }
        resolver, connection, opened = self._network_mocks(
            routes,
            {"doi.org": "8.8.8.8", "publisher.example": "1.1.1.1"},
        )
        with resolver, connection:
            fields, provider = _doi_exact("10.1234/public-redirect", "test")

        self.assertEqual(provider, "doi-content-negotiation")
        self.assertEqual(fields["title"], "A Public Redirected DOI")
        self.assertEqual([entry[0] for entry in opened], ["doi.org", "publisher.example"])

    def test_unsafe_doi_redirect_falls_back_to_crossref(self) -> None:
        crossref = {
            "message": {
                "title": ["Crossref Fallback"],
                "DOI": "10.1234/private-redirect",
                "container-title": ["Journal of Fallbacks"],
            },
        }
        routes = {
            ("doi.org", "/10.1234/private-redirect"): (302, {"Location": "https://metadata.internal/csl"}, b""),
            ("api.crossref.org", "/works/10.1234%2Fprivate-redirect"): (
                200,
                {"Content-Type": "application/json"},
                json.dumps(crossref).encode(),
            ),
        }
        resolver, connection, opened = self._network_mocks(
            routes,
            {"doi.org": "8.8.8.8", "metadata.internal": "10.0.0.8", "api.crossref.org": "1.1.1.1"},
        )
        with resolver, connection:
            fields, provider = _doi_exact("10.1234/private-redirect", "test")

        self.assertEqual(provider, "crossref-doi")
        self.assertEqual(fields["title"], "Crossref Fallback")
        self.assertEqual([entry[0] for entry in opened], ["doi.org", "api.crossref.org"])

    def test_https_connection_pins_the_validated_ip(self) -> None:
        connection = _PinnedHTTPSConnection("publisher.example", 443, "8.8.8.8", timeout=6)
        with patch("bibliography.socket.create_connection", return_value=sentinel.socket) as create:
            result = connection._create_connection(("publisher.example", 443), 6, None)

        self.assertIs(result, sentinel.socket)
        create.assert_called_once_with(("8.8.8.8", 443), 6, None)

    def test_reference_quick_read_uses_fixed_provider_and_strips_abstract_markup(self) -> None:
        fields = {
            "title": "A Unified Research Framework",
            "authors": ["Ada Lovelace"],
            "year": 2024,
            "venue": "Journal of Tests",
            "doi": "10.1234/example",
            "abstract": "<jats:p>A <b>bounded</b> abstract.</jats:p>",
        }
        citation = "Ada Lovelace. A Unified Research Framework. doi:10.1234/example"
        with patch("bibliography._doi_exact", return_value=(fields, "crossref-doi")) as exact:
            evidence = retrieve_reference_evidence(citation, contact_email="reader@example.org")

        exact.assert_called_once()
        self.assertEqual(evidence["evidence_level"], "abstract")
        self.assertEqual(evidence["fields"]["abstract"], "A bounded abstract.")
        self.assertEqual(evidence["sources"], [{"provider": "crossref-doi", "label": "Crossref Doi", "evidence": "abstract"}])

    def test_reference_quick_read_never_fetches_a_user_supplied_url(self) -> None:
        citation = "A cited paper. https://attacker.invalid/private"
        crossref = {"message": {"items": [{"title": ["A cited paper"]}]}}
        with patch("bibliography._fetch_json", return_value=crossref) as fetch:
            evidence = retrieve_reference_evidence(citation)

        requested_url = fetch.call_args.args[0]
        self.assertTrue(requested_url.startswith("https://api.crossref.org/works?"))
        self.assertNotIn("attacker.invalid/private", requested_url)
        self.assertEqual(evidence["evidence_level"], "metadata")


if __name__ == "__main__":
    unittest.main()
