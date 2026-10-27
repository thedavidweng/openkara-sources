// SPDX-License-Identifier: AGPL-3.0-only
// NetEase QuickJS producer: real bundled entry bytes through the actual
// a50 engine/host_api/crypto with fixture upstreams only. No real NetEase
// traffic, no real account. Host version is an explicit future-contract
// fixture ("0.19.0"), never a claim of production 0.18.2 compatibility.
use super::test_support::RegistryFixture;
use super::*;
use mockito::{Matcher, Server, ServerGuard};
use serde_json::{json, Value};
use std::time::Duration;

const MUSIC: &str = "https://music.163.com";
const INTERFACEPC: &str = "https://interfacepc.music.163.com";

const BUNDLE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../bundle-entry.mjs"));

fn producer_manifest() -> SourceManifest {
    let mut manifest: SourceManifest =
        serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/entry-manifest.json"))).unwrap();
    manifest.source_id = "netease".into();
    manifest.package_id = "org.openkara.netease-quickjs".into();
    manifest.publisher = "org.openkara".into();
    manifest.version = "2.0.0".into();
    manifest
}

struct ProducerFixture {
    _root: tempfile::TempDir,
    _registry: RegistryFixture,
    host: SourceHost,
    music: ServerGuard,
    interfacepc: ServerGuard,
}

impl ProducerFixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let mut registry = RegistryFixture::new("org.openkara").await;
        let manifest = producer_manifest();
        registry.publish_sources(&[(manifest, BUNDLE.into())]).await;
        let music = Server::new_async().await;
        let interfacepc = Server::new_async().await;
        let mut config = HostConfig::fixture(root.path().to_path_buf(), "0.19.0".into());
        config.describe_timeout = Duration::from_secs(5);
        config.operation_timeout = Duration::from_secs(10);
        config.engine_memory_limit = 64 * 1024 * 1024;
        config.add_fixture_upstream(MUSIC.into(), music.url());
        config.add_fixture_upstream(INTERFACEPC.into(), interfacepc.url());
        let host = SourceHost::new(config).await.unwrap();
        host.add_registry(&registry.url()).await.unwrap();
        host.install_package(
            registry.registry_id(),
            "org.openkara.netease-quickjs",
            None,
            false,
            false,
        )
        .await
        .unwrap();
        host.set_enabled("netease", true, false).await.unwrap();
        Self {
            _root: root,
            _registry: registry,
            host,
            music,
            interfacepc,
        }
    }

    async fn call(&self, method: &str, params: Value) -> Value {
        self.host.request("netease", method, params).await.unwrap()
    }
}

fn account_body() -> String {
    json!({"code":200,"account":{"id":424242},"profile":{"nickname":"fixture"}}).to_string()
}

async fn mock_account(server: &mut ServerGuard, times: usize) -> mockito::Mock {
    server
        .mock("POST", "/weapi/nuser/account/get")
        .match_header("content-type", Matcher::Regex("application/x-www-form-urlencoded.*".into()))
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(account_body())
        .expect(times)
        .create_async()
        .await
}

#[tokio::test]
async fn producer_describes_signed_out_and_restores_session() {
    let mut fixture = ProducerFixture::new().await;
    let description = fixture.call("describe", json!({})).await;
    assert_eq!(description["package_id"], "org.openkara.netease-quickjs");
    assert_eq!(description["source_id"], "netease");
    assert_eq!(description["protocol"]["major"], 2);
    assert_eq!(description["session"]["state"], "signed_out");

    let account = mock_account(&mut fixture.music, 1).await;
    let restored = fixture
        .call(
            "session.restore",
            json!({"credentials": {"MUSIC_U": "bindingsynthetic0000000000001", "__csrf": "csrf000000000000000000000001"}}),
        )
        .await;
    assert_eq!(restored["state"], "signed_in");
    assert_eq!(restored["account"]["id"], "424242");
    account.assert_async().await;

    let sessions = fixture.call("describe", json!({})).await;
    assert_eq!(sessions["session"]["state"], "signed_in");
    let signed_out = fixture.call("auth.sign_out", json!({})).await;
    assert_eq!(signed_out["state"], "signed_out");
}

#[tokio::test]
async fn producer_rejects_bad_signatures_without_upstream() {
    let fixture = ProducerFixture::new().await;
    let bad = fixture
        .host
        .request("netease", "session.restore", json!({"credentials": {"MUSIC_U": "short", "__csrf": "x"}}))
        .await;
    assert!(bad.is_err(), "malformed credentials must fail before any request");
}

#[tokio::test]
async fn producer_search_maps_weapi_and_eapi_results() {
    let mut fixture = ProducerFixture::new().await;
    let account = mock_account(&mut fixture.music, 1).await;
    fixture
        .call(
            "session.restore",
            json!({"credentials": {"MUSIC_U": "bindingsynthetic0000000000001", "__csrf": "csrf000000000000000000000001"}}),
        )
        .await;
    let cloud = fixture
        .interfacepc
        .mock("POST", "/eapi/cloudsearch/pc")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(
            json!({"code":200,"result":{"songs":[{"id":11,"name":"song","ar":[{"name":"artist"}],"al":{"picUrl":"https://p1.music.126.net/x.jpg"}}],"songCount":1}}).to_string(),
        )
        .expect(1)
        .create_async()
        .await;
    let found = fixture.call("search", json!({"query": "song"})).await;
    assert_eq!(found["items"].as_array().unwrap().len(), 1);
    assert_eq!(found["items"][0]["id"], "11");
    account.assert_async().await;
    cloud.assert_async().await;
}
