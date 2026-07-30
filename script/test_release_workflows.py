#!/usr/bin/env python3

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RELEASE_WORKFLOWS = (
    ROOT / ".github" / "workflows" / "release.yml",
    ROOT / ".github" / "workflows" / "release-dev.yml",
)

EXPECTED_MACOS_ARGS = (
    'args: "--target aarch64-apple-darwin --bundles app,dmg"',
    'args: "--target x86_64-apple-darwin --bundles app,dmg"',
)

LEGACY_MACOS_ARGS = (
    'args: "--target aarch64-apple-darwin --bundles app"',
    'args: "--target x86_64-apple-darwin --bundles app"',
)


class ReleaseWorkflowTests(unittest.TestCase):
    def test_release_workflows_publish_app_and_dmg_for_macos(self) -> None:
        for workflow in RELEASE_WORKFLOWS:
            content = workflow.read_text()

            for expected_arg in EXPECTED_MACOS_ARGS:
                self.assertIn(expected_arg, content, f"{workflow} missing `{expected_arg}`")

            for legacy_arg in LEGACY_MACOS_ARGS:
                self.assertNotIn(legacy_arg, content, f"{workflow} still contains `{legacy_arg}`")

    def test_release_workflows_execute_pdf_sidecar_verification(self) -> None:
        for workflow in RELEASE_WORKFLOWS:
            content = workflow.read_text()
            self.assertIn(
                "bash script/verify_pdf_sidecar_binary.sh",
                content,
                f"{workflow} must execute the bundled PDF sidecar, not just list it",
            )

    def test_release_workflows_stage_agent_worker_before_builds(self) -> None:
        for workflow in RELEASE_WORKFLOWS:
            content = workflow.read_text()
            self.assertIn(
                "textlingo-desktop/agent-worker/package-lock.json",
                content,
                f"{workflow} must include the agent worker lockfile in the npm cache key",
            )

            ci_stage_index = content.index("- name: Stage bundled agent worker")
            rust_tests_index = content.index("- name: Rust tests")
            self.assertLess(
                ci_stage_index,
                rust_tests_index,
                f"{workflow} must stage worker resources before Rust validates Tauri config",
            )

            publish_job_index = content.index("  publish-tauri:")
            publish_stage_index = content.index(
                "- name: stage bundled agent worker",
                publish_job_index,
            )
            tauri_build_index = content.index(
                "- uses: tauri-apps/tauri-action@v0",
                publish_job_index,
            )
            self.assertLess(
                publish_stage_index,
                tauri_build_index,
                f"{workflow} must stage worker resources before building release packages",
            )

    def test_release_workflows_assert_packaged_worker_on_macos(self) -> None:
        expected_paths = (
            'AGENT_NODE="$APP/Contents/MacOS/openkoto-agent-node"',
            'AGENT_WORKER="$APP/Contents/Resources/resources/agent-worker/dist/index.js"',
            'OPENCODE="$APP/Contents/MacOS/opencode"',
        )
        for workflow in RELEASE_WORKFLOWS:
            content = workflow.read_text()
            for expected_path in expected_paths:
                self.assertIn(
                    expected_path,
                    content,
                    f"{workflow} must verify packaged agent worker artifact `{expected_path}`",
                )
            self.assertIn(
                '"$AGENT_NODE" --version',
                content,
                f"{workflow} must execute the packaged Node runtime",
            )
            self.assertIn(
                """grep -q '"event":"worker.ready"'""",
                content,
                f"{workflow} must smoke-test the packaged worker entry",
            )


if __name__ == "__main__":
    unittest.main()
