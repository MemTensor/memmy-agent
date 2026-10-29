from __future__ import annotations

import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("yunxiao_github_sync.py")
SPEC = importlib.util.spec_from_file_location("yunxiao_github_sync", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


REPOSITORY = "MemTensor/memmy-agent"
CFG = {
    "org": "org", "project_id": "project", "workitem_category": "Req",
    "type_id": "type", "assignee_id": "assignee", "priority_id": "priority",
    "parent_id": "", "sprint_id": "sprint", "participant_ids": ["participant"],
    "statuses": {"待处理": "pending", "已取消": "cancelled"},
}


def source_item(number=42, *, kind="issue", repository=REPOSITORY):
    return {
        "number": number, "title": "Fix scheduler", "state": "open", "labels": [],
        "html_url": MODULE.source_url(kind, number, repository),
        "created_at": "2026-09-10T00:00:00Z", "body": "Details",
    }


def source_card(identifier="card", *, number=42, kind="issue", repository=REPOSITORY, form="short"):
    item = source_item(number, kind=kind, repository=repository)
    prefix = {
        "short": f"[{MODULE.SOURCE_LABELS[kind]} #{number}]",
        "long": MODULE.build_source_key(kind, item, repository),
        "legacy": MODULE.legacy_source_key(kind, item),
    }[form]
    return {
        "id": identifier, "subject": f"{prefix} Fix scheduler",
        "description": MODULE.item_description(item), "status": "closed-custom",
        "sprint": "manual-sprint", "assignedTo": "manual-owner",
    }


class MemoryTransport:
    """A stateful API fixture: subject searches see changes made by PUT."""

    def __init__(self, cards=()):
        self.cards = {card["id"]: dict(card) for card in cards}
        self.calls = []
        self.omit_description = False

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, body))
        if path.endswith("workitems:search"):
            key = json.loads(body["conditions"])["conditionGroups"][0][0]["value"][0]
            cards = [dict(card) for card in self.cards.values() if key in card["subject"]]
            offset = (body["page"] - 1) * body["perPage"]
            cards = cards[offset:offset + body["perPage"]]
            if self.omit_description:
                for card in cards:
                    card.pop("description", None)
            return cards
        if method == "GET":
            return dict(self.cards[path.rsplit("/", 1)[-1]])
        if method == "PUT":
            self.cards[path.rsplit("/", 1)[-1]].update(body)
            return None
        if method == "POST" and path.endswith("/workitems"):
            identifier = f"new-{len(self.cards)}"
            self.cards[identifier] = {"id": identifier, **body}
            return {"id": identifier}
        raise AssertionError((method, path, body))


class YunxiaoSyncTests(unittest.TestCase):
    def test_source_key_includes_repository(self) -> None:
        item = {"number": 42, "title": "Fix scheduler"}
        self.assertEqual(
            MODULE.build_source_key("issue", item, "MemTensor/memmy-agent"),
            "[GitHub MemTensor/memmy-agent Issue #42]",
        )

    def test_title_keeps_type_and_number_without_repository_prefix(self) -> None:
        item = {"number": 42, "title": "Fix scheduler"}
        self.assertEqual(
            MODULE.build_title("issue", item, "MemTensor/memmy-agent"),
            "[Issue #42] Fix scheduler",
        )
        self.assertEqual(
            MODULE.build_title("pr", item, REPOSITORY), "[PR #42] Fix scheduler"
        )

    def test_source_status(self) -> None:
        self.assertEqual(MODULE.source_status("issue", {"state": "open"}), "待处理")
        self.assertEqual(
            MODULE.source_status("pr", {"state": "closed", "merged": True}),
            "已完成",
        )
        self.assertEqual(
            MODULE.source_status("issue", {"state": "closed"}),
            "已取消",
        )

    def test_only_community_pull_requests_are_synced(self) -> None:
        for association in (
            "CONTRIBUTOR",
            "FIRST_TIMER",
            "FIRST_TIME_CONTRIBUTOR",
            "NONE",
            "contributor",
        ):
            self.assertTrue(
                MODULE.should_sync_pull_request(
                    {"author_association": association}
                )
            )

    def test_internal_pull_request_event_skips_before_cloud_api_calls(self) -> None:
        event = {
            "action": "opened",
            "repository": {"full_name": "MemTensor/memmy-agent"},
            "pull_request": {
                "number": 99,
                "title": "Internal change",
                "state": "open",
                "author_association": "MEMBER",
            },
        }
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            suffix=".json",
        ) as event_file:
            json.dump(event, event_file)
            event_file.flush()
            with (
                patch.dict(
                    os.environ,
                    {"GITHUB_EVENT_PATH": event_file.name},
                    clear=False,
                ),
                patch.object(
                    MODULE,
                    "configuration_from_environment",
                    side_effect=AssertionError("internal PR must not call Yunxiao"),
                ),
            ):
                self.assertEqual(MODULE.handle_event(object()), 0)

        for association in ("OWNER", "MEMBER", "COLLABORATOR", "MANNEQUIN", ""):
            self.assertFalse(
                MODULE.should_sync_pull_request(
                    {"author_association": association}
                )
            )

    def test_resolve_statuses_accepts_memmy_workflow_names(self) -> None:
        workflow = [
            {"id": "pending", "name": "待处理"},
            {"id": "developing", "name": "开发中"},
            {"id": "developed", "name": "开发完成"},
            {"id": "cancelled", "name": "已取消"},
        ]
        self.assertEqual(
            MODULE.resolve_statuses(workflow),
            {
                "待处理": "pending",
                "已完成": "developed",
                "已取消": "cancelled",
            },
        )

    def test_create_payload_contains_parent_and_sprint(self) -> None:
        calls = []

        def transport(method, path, body=None):
            calls.append((method, path, body))
            if "search" in path:
                return {"data": {"workitems": []}}
            return {"id": "new-id"}

        cfg = {
            "project_id": "project",
            "workitem_category": "Req",
            "type_id": "type",
            "assignee_id": "assignee",
            "priority_id": "priority",
            "parent_id": "directory",
            "sprint_id": "sprint",
            "participant_ids": ["participant-a", "participant-b"],
            "statuses": {"待处理": "pending", "已取消": "cancelled"},
        }
        item = {
            "number": 1,
            "title": "Test",
            "html_url": "https://github.com/MemTensor/memmy-agent/issues/1",
            "body": "Details",
            "created_at": "2026-09-10T00:00:00Z",
            "state": "open",
            "labels": [],
        }
        result = MODULE.sync_one(
            "org",
            cfg,
            "issue",
            item,
            repository="MemTensor/memmy-agent",
            apply=True,
            label_ids={},
            days_to_finish=7,
            create_closed=False,
            client=MODULE.YunxiaoClient(transport),
        )
        self.assertEqual(result, "created")
        self.assertEqual(calls[-1][2]["parentId"], "directory")
        self.assertEqual(calls[-1][2]["sprint"], "sprint")
        self.assertEqual(calls[-1][2]["participants"], ["participant-a", "participant-b"])
        self.assertIn("Details", calls[-1][2]["description"])
        self.assertEqual(calls[-1][2]["subject"], "[Issue #1] Test")

    def test_reopened_item_updates_to_pending(self) -> None:
        calls = []

        def transport(method, path, body=None):
            calls.append((method, path, body))
            existing = source_card("existing", number=2, form="long")
            existing["subject"] = "[GitHub MemTensor/memmy-agent Issue #2] Reopen"
            if "search" in path:
                return {"data": {"workitems": [existing]}}
            if method == "GET":
                return existing
            return {}

        cfg = {
            "project_id": "project",
            "workitem_category": "Req",
            "type_id": "type",
            "assignee_id": "assignee",
            "priority_id": "priority",
            "parent_id": "",
            "sprint_id": "",
            "participant_ids": ["participant-a", "participant-b"],
            "statuses": {"待处理": "pending", "已取消": "cancelled"},
        }
        result = MODULE.sync_one(
            "org",
            cfg,
            "issue",
            {
                "number": 2,
                "title": "Reopen",
                "html_url": "https://github.com/MemTensor/memmy-agent/issues/2",
                "created_at": "2026-09-10T00:00:00Z",
                "state": "open",
                "labels": [],
            },
            repository="MemTensor/memmy-agent",
            apply=True,
            label_ids={},
            days_to_finish=7,
            create_closed=False,
            client=MODULE.YunxiaoClient(transport),
        )
        self.assertEqual(result, "updated-status")
        self.assertEqual(
            calls[-1][2],
            {
                "status": "pending",
                "subject": "[Issue #2] Reopen",
                "assignedTo": "assignee",
                "participants": ["participant-a", "participant-b"],
            },
        )

    def test_all_state_backfill_can_create_closed_item(self) -> None:
        calls = []

        def transport(method, path, body=None):
            calls.append((method, path, body))
            if "search" in path:
                return {"data": {"workitems": []}}
            return {"id": "new-id"}

        cfg = {
            "project_id": "project",
            "workitem_category": "Req",
            "type_id": "type",
            "assignee_id": "assignee",
            "priority_id": "priority",
            "parent_id": "",
            "sprint_id": "",
            "participant_ids": [],
            "statuses": {"待处理": "pending", "已取消": "cancelled"},
        }
        result = MODULE.sync_one(
            "org",
            cfg,
            "issue",
            {
                "number": 3,
                "title": "Closed before rollout",
                "html_url": "https://github.com/MemTensor/memmy-agent/issues/3",
                "created_at": "2026-09-10T00:00:00Z",
                "state": "closed",
                "labels": [],
            },
            repository="MemTensor/memmy-agent",
            apply=True,
            label_ids={},
            days_to_finish=7,
            create_closed=True,
            client=MODULE.YunxiaoClient(transport),
        )
        self.assertEqual(result, "created")
        self.assertEqual(calls[-1][2]["status"], "cancelled")

    def find_existing(self, transport, *, kind="issue", number=42):
        return MODULE.find_existing_workitem(
            "org", "project", kind, source_item(number, kind=kind), REPOSITORY,
            MODULE.YunxiaoClient(transport), category="Req",
        )

    def sync(self, transport):
        return MODULE.sync_one(
            "org", CFG, "issue", source_item(), repository=REPOSITORY,
            apply=True, label_ids={}, days_to_finish=7, create_closed=False,
            client=MODULE.YunxiaoClient(transport),
        )

    def rename(self, transport, *, apply=False):
        output = io.StringIO()
        with (
            patch.dict(os.environ, {"GITHUB_REPOSITORY": REPOSITORY}),
            patch.object(MODULE, "configuration_from_environment", return_value=CFG),
            patch.object(MODULE.time, "sleep"),
            redirect_stdout(output),
        ):
            result = MODULE.rename_titles(MODULE.YunxiaoClient(transport), apply=apply)
        return result, json.loads(output.getvalue())["titles"]

    def test_description_source_requires_the_leading_source_line(self):
        url = MODULE.source_url("issue", 42, REPOSITORY)
        self.assertEqual(MODULE.description_source_url(f"GitHub: {url}\n\nBody"), url.casefold())
        self.assertEqual(
            MODULE.description_source_url(f'<p>GitHub: <a href="{url}">{url}</a></p><p>Body</p>'),
            url.casefold(),
        )
        self.assertIsNone(MODULE.description_source_url(f"Body mentions\nGitHub: {url}"))
        self.assertIsNone(MODULE.description_source_url(f"GitHub: {url}#issuecomment-1"))

    def test_legacy_source_sections_accept_bom_and_paragraph_whitespace(self):
        issue_url = MODULE.source_url("issue", 394, REPOSITORY)
        pr_url = MODULE.source_url("pr", 395, REPOSITORY)
        cases = (
            (f"来源：GitHub Issue #394 \ufeff{issue_url}\ufeff \ufeff 问题现象", issue_url),
            (f"来源：GitHub PR #395\n\n{pr_url}\n\n问题\nDetails", pr_url),
            (f'<div>来源：GitHub PR #395</div><div><a href="{pr_url}">{pr_url}</a></div><div>Details</div>', pr_url),
        )
        for description, expected in cases:
            with self.subTest(description=description):
                self.assertEqual(MODULE.description_source_url(description), expected.casefold())

    def test_legacy_source_sections_reject_quoted_or_mismatched_sources(self):
        for description in (
            "Body first\n来源：GitHub Issue #394\nhttps://github.com/MemTensor/memmy-agent/issues/394",
            "来源：GitHub Issue #394\nhttps://github.com/MemTensor/memmy-agent/issues/395",
            "来源：GitHub PR #395\nhttps://github.com/MemTensor/memmy-agent/issues/395",
            "来源：GitHub Issue #394\nhttps://example.com/MemTensor/memmy-agent/issues/394",
            "来源：GitHub Issue #394\nhttps://github.com/MemTensor/memmy-agent/issues/394#issuecomment-1",
            "来源：GitHub Issue #394\nUnrelated text\nhttps://github.com/MemTensor/memmy-agent/issues/394",
        ):
            with self.subTest(description=description):
                self.assertIsNone(MODULE.description_source_url(description))

    def test_title_cleanup_accepts_verified_legacy_source_sections(self):
        for kind, number in (("issue", 394), ("pr", 395)):
            with self.subTest(kind=kind):
                card = source_card(number=number, kind=kind, form="long")
                card["description"] = (
                    f"来源：GitHub {MODULE.SOURCE_LABELS[kind]} #{number}\n\n"
                    f"{MODULE.source_url(kind, number, REPOSITORY)}\n\nDetails"
                )
                transport = MemoryTransport([card])
                result, stats = self.rename(transport, apply=True)
                self.assertEqual((result, stats["renamed"], stats["failed"]), (0, 1, 0))
                self.assertEqual(transport.cards["card"]["description"], card["description"])
                writes = [body for method, _, body in transport.calls if method == "PUT"]
                self.assertEqual(writes, [{"subject": f"[{MODULE.SOURCE_LABELS[kind]} #{number}] Fix scheduler"}])

    def test_sync_after_create_and_after_rename_reuses_the_same_card(self):
        transport = MemoryTransport()
        self.assertEqual(self.sync(transport), "created")
        self.assertEqual(self.sync(transport), "updated-status")
        self.assertEqual(len(transport.cards), 1)
        self.assertEqual(transport.cards["new-0"]["subject"], "[Issue #42] Fix scheduler")
        for form in ("long", "legacy"):
            with self.subTest(form=form):
                transport = MemoryTransport([source_card(form=form)])
                self.assertEqual(self.sync(transport), "updated-status")
                self.assertEqual(self.sync(transport), "updated-status")
                self.assertEqual(list(transport.cards), ["card"])
                self.assertEqual(transport.cards["card"]["subject"], "[Issue #42] Fix scheduler")

    def test_same_number_from_another_repository_is_not_selected(self):
        transport = MemoryTransport([
            source_card("foreign", repository="Other/repository"),
            source_card("target"),
        ])
        self.assertEqual(self.find_existing(transport), "target")

    def test_sync_preserves_the_human_edited_title_suffix(self):
        for form in ("long", "legacy", "short"):
            with self.subTest(form=form):
                card = source_card(form=form)
                card["subject"] = card["subject"].replace("Fix scheduler", "Human-maintained title")
                transport = MemoryTransport([card])
                self.assertEqual(self.sync(transport), "updated-status")
                self.assertEqual(transport.cards["card"]["subject"], "[Issue #42] Human-maintained title")

    def test_issue_and_pr_with_same_number_are_separate(self):
        transport = MemoryTransport([source_card("issue"), source_card("pr", kind="pr")])
        self.assertEqual(self.find_existing(transport, kind="pr"), "pr")

    def test_missing_search_description_uses_workitem_detail(self):
        transport = MemoryTransport([source_card()])
        transport.omit_description = True
        self.assertEqual(self.find_existing(transport), "card")
        self.assertTrue(any(method == "GET" for method, _, _ in transport.calls))

    def test_search_description_projection_does_not_replace_detail_reads(self):
        for description in ("", None, " ", "<p><br/></p>", "Description summary", source_card()["description"]):
            with self.subTest(description=description):
                transport = MemoryTransport([source_card(form="long")])

                def projected(method, path, body=None):
                    response = transport(method, path, body)
                    if path.endswith("workitems:search"):
                        return [{**card, "description": description} for card in response]
                    return response

                self.assertEqual(self.find_existing(projected), "card")
                self.assertTrue(any(method == "GET" for method, _, _ in transport.calls))
                result, stats = self.rename(projected)
                self.assertEqual((result, stats["would_rename"], stats["failed"]), (0, 1, 0))
                result, stats = self.rename(projected, apply=True)
                self.assertEqual((result, stats["renamed"], stats["failed"]), (0, 1, 0))
                writes = [body for method, _, body in transport.calls if method == "PUT"]
                self.assertEqual(writes, [{"subject": "[Issue #42] Fix scheduler"}])

    def test_detail_source_overrides_a_valid_looking_search_source(self):
        transport = MemoryTransport([source_card(form="long")])

        def projected(method, path, body=None):
            response = transport(method, path, body)
            if path.endswith("workitems:search"):
                return response
            if method == "GET":
                return {**response, "description": "GitHub: https://github.com/Other/repo/issues/42"}
            return response

        self.assertIsNone(self.find_existing(projected))
        result, stats = self.rename(projected, apply=True)
        self.assertEqual((result, stats["renamed"], stats["skipped"]), (0, 0, 1))
        self.assertFalse(any(method == "PUT" for method, _, _ in transport.calls))

    def test_matching_candidate_on_a_later_page_is_found(self):
        cards = [source_card(f"foreign-{i}", repository=f"Other/repository-{i}") for i in range(4)]
        transport = MemoryTransport([*cards, source_card("target")])
        with patch.object(MODULE, "SEARCH_PAGE_SIZE", 2):
            self.assertEqual(self.find_existing(transport), "target")
        self.assertIn(3, [body["page"] for _, path, body in transport.calls if path.endswith(":search")])

    def test_duplicates_across_title_formats_block_writes(self):
        transport = MemoryTransport([source_card("a"), source_card("b", form="long")])
        with self.assertRaisesRegex(MODULE.PreflightError, "多个"):
            self.sync(transport)
        self.assertFalse(any(method == "PUT" for method, _, _ in transport.calls))

    def test_unverifiable_matching_card_blocks_duplicate_creation(self):
        card = source_card()
        card["description"] = "Manual text without a source line"
        transport = MemoryTransport([card])
        with self.assertRaisesRegex(MODULE.PreflightError, "缺少可验证"):
            self.sync(transport)
        self.assertEqual(len(transport.cards), 1)

    def test_malformed_search_response_does_not_look_like_no_matches(self):
        with self.assertRaisesRegex(MODULE.PreflightError, "无法解析"):
            self.find_existing(lambda *args: {"unexpected": []})

    def test_search_stops_at_the_api_pagination_window(self):
        transport = MemoryTransport([source_card(str(i)) for i in range(3)])
        with (
            patch.object(MODULE, "SEARCH_PAGE_SIZE", 2),
            patch.object(MODULE, "SEARCH_WINDOW", 2),
            self.assertRaisesRegex(MODULE.PreflightError, "分页窗口"),
        ):
            self.find_existing(transport)

    def test_title_cleanup_preview_has_no_writes(self):
        transport = MemoryTransport([source_card(form="long")])
        before = json.dumps(transport.cards)
        result, stats = self.rename(transport)
        self.assertEqual(result, 0)
        self.assertEqual(stats["would_rename"], 1)
        self.assertEqual(stats["renamed"], 0)
        self.assertEqual(json.dumps(transport.cards), before)
        self.assertTrue(all(method in ("GET", "POST") and not path.endswith("/workitems")
                            for method, path, _ in transport.calls))

    def test_title_cleanup_collects_all_pages_then_changes_subject_only(self):
        cards = [source_card(str(i), number=i + 1, form="long") for i in range(5)]
        cards.append(source_card("legacy", number=6, form="legacy"))
        cards.append(source_card("foreign", repository="Other/repo", form="legacy"))
        transport = MemoryTransport(cards)
        with patch.object(MODULE, "SEARCH_PAGE_SIZE", 2):
            result, stats = self.rename(transport, apply=True)
        self.assertEqual(result, 0)
        self.assertEqual(stats["renamed"], 6)
        self.assertEqual(stats["skipped"], 1)
        for before in cards:
            after = transport.cards[before["id"]]
            for field in ("description", "status", "sprint", "assignedTo"):
                self.assertEqual(before[field], after[field])
        writes = [body for method, _, body in transport.calls if method == "PUT"]
        self.assertEqual(len(writes), 6)
        self.assertTrue(all(set(body) == {"subject"} for body in writes))
        transport.calls.clear()
        _, repeated = self.rename(transport, apply=True)
        self.assertEqual(repeated["renamed"], 0)
        self.assertFalse(any(method == "PUT" for method, _, _ in transport.calls))

    def test_title_cleanup_duplicate_sources_are_not_renamed(self):
        transport = MemoryTransport([source_card("a", form="long"), source_card("b", form="legacy")])
        result, stats = self.rename(transport, apply=True)
        self.assertEqual(result, 1)
        self.assertEqual(stats["failed"], 2)
        self.assertFalse(any(method == "PUT" for method, _, _ in transport.calls))

    def test_title_cleanup_detects_duplicate_already_short_cards(self):
        transport = MemoryTransport([source_card("a"), source_card("b", form="long")])
        result, stats = self.rename(transport, apply=True)
        self.assertEqual(result, 1)
        self.assertEqual(stats["failed"], 2)
        self.assertEqual(stats["renamed"], 0)
        self.assertFalse(any(method == "PUT" for method, _, _ in transport.calls))

    def test_title_cleanup_does_not_overwrite_a_concurrent_edit(self):
        transport = MemoryTransport([source_card(form="long")])

        detail_reads = 0

        def concurrent_transport(method, path, body=None):
            nonlocal detail_reads
            if method == "GET":
                detail_reads += 1
                if detail_reads == 2:
                    transport.cards["card"]["subject"] = "Manually edited title"
            return transport(method, path, body)

        result, stats = self.rename(concurrent_transport, apply=True)
        self.assertEqual(result, 1)
        self.assertEqual(stats["failed"], 1)
        self.assertFalse(any(method == "PUT" for method, _, _ in transport.calls))

    def test_explicit_dry_run_overrides_apply_for_title_cleanup(self):
        with (
            patch.dict(os.environ, {"YUNXIAO_TOKEN": "test-token"}),
            patch.object(MODULE.sys, "argv", ["sync", "--mode", "rename-titles", "--apply", "--dry-run"]),
            patch.object(MODULE, "rename_titles", return_value=0) as rename,
        ):
            self.assertEqual(MODULE.main(), 0)
        self.assertFalse(rename.call_args.kwargs["apply"])


if __name__ == "__main__":
    unittest.main()
