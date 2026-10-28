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

fn producer_manifest() -> SourceManifest {
    serde_json::from_slice(&std::fs::read(std::env::var("PRODUCER_MANIFEST").unwrap()).unwrap()).unwrap()
}

async fn publish_exact(registry: &mut RegistryFixture, manifest: &SourceManifest) {
    use base64::Engine;
    use sha2::{Digest, Sha512};
    let bytes = std::fs::read(std::env::var("PRODUCER_TAR").unwrap()).unwrap();
    let integrity = format!("sha512-{}", base64::engine::general_purpose::STANDARD.encode(Sha512::digest(&bytes)));
    let url = format!("{}/source.tgz", registry.server.url());
    let document = json!({"format_version":1,"registry_id":"org.openkara","display_name":"Fixture", "homepage":"https://registry.openkara.test/", "packages":[{
        "package_id":manifest.package_id,"source_id":manifest.source_id,"name":manifest.name,"description":manifest.description,"license":manifest.license,
        "versions":[{"version":manifest.version,"protocol_majors":manifest.protocol.majors,"minimum_host_version":manifest.minimum_host_version,"size":bytes.len(),"integrity":integrity,"urls":[url],"resource_origins":manifest.resource_origins,"media_origins":manifest.media_origins,"capabilities":manifest.capabilities}]
    }]});
    registry.server.mock("GET", "/source.tgz").with_body(bytes).create_async().await;
    registry.server.mock("GET", "/registry.json").with_body(serde_json::to_vec(&document).unwrap()).create_async().await;
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
        publish_exact(&mut registry, &manifest).await;
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

const SYNTH_CREDS: &str = "bindingsynthetic0000000000001";
const SYNTH_CSRF: &str = "csrf000000000000000000000001";

fn synth_creds() -> Value {
    json!({"credentials": {"MUSIC_U": SYNTH_CREDS, "__csrf": SYNTH_CSRF}})
}

async fn restore(fi_item: &mut ProducerFixture) {
    let account = mock_account(&mut fi_item.music, 1).await;
    let restored = fi_item.call("session.restore", synth_creds()).await;
    assert_eq!(restored["state"], "signed_in");
    assert_eq!(restored["account"]["id"], "424242");
    account.assert_async().await;
}

#[tokio::test]
async fn producer_all_seven_operations_map_responses() {
    // weapi: user_account (auth), user_playlist, song_detail.
    // eapi:  likelist, playlist_detail, cloudsearch, song_url.
    let mut fixture = ProducerFixture::new().await;
    restore(&mut fixture).await;

    let playlist = fixture
        .music
        .mock("POST", "/weapi/user/playlist")
        .with_status(200)
        .with_body(
            json!({"code":200,"playlist":[{"id":9,"name":"pl","coverImgUrl":"https://p2.music.126.net/x.jpg","trackCount":1}],"more":false}).to_string(),
        )
        .expect(1)
        .create_async()
        .await;
    let detail = fixture
        .music
        .mock("POST", "/weapi/v3/song/detail")
        .with_status(200)
        .with_body(
            json!({"code":200,"songs":[{"id":5,"name":"s","al":{"picUrl":"https://P1.MUSIC.126.NET/a.jpg"},"ar":[{"name":"ar"}],"dt":1000}],"privileges":[{"pl":1}]}).to_string(),
        )
        // liked_tracks caches id 5; later playlist.tracks/tracks.get reuse
        // the cache, so only the first miss hits the wire.
        .expect(1)
        .create_async()
        .await;
    let likelist = fixture
        .interfacepc
        .mock("POST", "/eapi/song/like/get")
        .with_status(200)
        .with_body(json!({"code":200,"ids":[5]}).to_string())
        .expect(1)
        .create_async()
        .await;
    let detail_pl = fixture
        .interfacepc
        .mock("POST", "/eapi/v6/playlist/detail")
        .with_status(200)
        .with_body(
            json!({"code":200,"playlist":{"id":9,"name":"pl","trackIds":[{"id":5}]}}).to_string(),
        )
        .expect(1)
        .create_async()
        .await;
    let cloud = fixture
        .interfacepc
        .mock("POST", "/eapi/cloudsearch/pc")
        .with_status(200)
        .with_body(
            json!({"code":200,"result":{"songs":[{"id":5,"name":"s","al":{},"ar":[]}],"songCount":1}}).to_string(),
        )
        .expect(1)
        .create_async()
        .await;
    let url = fixture
        .interfacepc
        .mock("POST", "/eapi/song/enhance/player/url")
        .with_status(200)
        .with_body(
            json!({"code":200,"data":[{"id":5,"url":"https://m7.music.126.net:443/f.mp3","type":"mp3","expi":100,"br":320000}]}).to_string(),
        )
        .expect(1)
        .create_async()
        .await;

    let playlists = fixture.call("playlists", json!({})).await;
    assert_eq!(playlists["items"][0]["id"], "9");
    let liked = fixture.call("liked_tracks", json!({})).await;
    assert_eq!(liked["items"][0]["id"], "5");
    let tracks = fixture
        .call("playlist.tracks", json!({"playlist_id": "9"}))
        .await;
    assert_eq!(tracks["items"][0]["id"], "5");
    let got = fixture.call("tracks.get", json!({"track_ids": ["5"]})).await;
    assert_eq!(got["items"][0]["id"], "5");
    let found = fixture.call("search", json!({"query": "song"})).await;
    assert_eq!(found["items"][0]["id"], "5");
    let media = fixture
        .call("media.resolve", json!({"track_id": "5", "purpose": "preview"}))
        .await;
    assert_eq!(media["kind"], "media");
    assert_eq!(media["media"]["file_extension"], "mp3");

    for mock in [playlist, detail, likelist, detail_pl, cloud, url] {
        mock.assert_async().await;
    }
}

#[tokio::test]
async fn producer_failure_and_privacy_paths_stay_safe() {
    let mut fixture = ProducerFixture::new().await;
    // 301 from the auth probe -> session_expired, never signed in.
    let denied = fixture
        .music
        .mock("POST", "/weapi/nuser/account/get")
        .with_status(200)
        .with_body(r#"{"code":301}"#)
        .expect(1)
        .create_async()
        .await;
    let expired = fixture.host.request("netease", "session.restore", synth_creds()).await;
    assert_eq!(expired.unwrap_err().code, "session_expired");
    denied.assert_async().await;

    restore(&mut fixture).await;
    let track_detail = fixture
        .music
        .mock("POST", "/weapi/v3/song/detail")
        .with_status(200)
        .with_body(
            json!({"code":200,"songs":[{"id":5,"name":"s","al":{},"ar":[]}],"privileges":[]}).to_string(),
        )
        // The second media.resolve reuses the cached track; only the first
        // miss hits the wire.
        .expect(1)
        .create_async()
        .await;
    // Upstream 404 on search -> not_found (no leak of the raw body).
    let missing = fixture
        .interfacepc
        .mock("POST", "/eapi/cloudsearch/pc")
        .with_status(200)
        .with_body(r#"{"code":404}"#)
        .expect(1)
        .create_async()
        .await;
    let not_found = fixture.host.request("netease", "search", json!({"query": "song"})).await;
    assert_eq!(not_found.unwrap_err().code, "not_found");
    // Unsupported audio container is refused, not served.
    let bad_type = fixture
        .interfacepc
        .mock("POST", "/eapi/song/enhance/player/url")
        .with_status(200)
        .with_body(r#"{"code":200,"data":[{"id":5,"url":"https://m7.music.126.net/f","type":"exe"}]}"#)
        .expect(1)
        .create_async()
        .await;
    let refused = fixture
        .host
        .request("netease", "media.resolve", json!({"track_id": "5", "purpose": "preview"}))
        .await;
    assert_eq!(refused.unwrap_err().code, "internal");
    // Trial-only track is a refusal payload, never a media URL.
    let trial = fixture
        .interfacepc
        .mock("POST", "/eapi/song/enhance/player/url")
        .with_status(200)
        .with_body(r#"{"code":200,"data":[{"id":5,"freeTrialInfo":{},"url":"https://m7.music.126.net/f.mp3","type":"mp3"}]}"#)
        .expect(1)
        .create_async()
        .await;
    let clip = fixture
        .call("media.resolve", json!({"track_id": "5", "purpose": "preview"}))
        .await;
    assert_eq!(clip["kind"], "refusal");
    assert_eq!(clip["refusal"]["reason"], "trial_clip");
    for mock in [missing, bad_type, trial, track_detail] {
        mock.assert_async().await;
    }
}

#[tokio::test]
async fn producer_auth_complete_synthetic() {
    let mut fixture = ProducerFixture::new().await;
    let account = mock_account(&mut fixture.music, 1).await;
    let start = fixture.call("auth.start", json!({})).await;
    let completed = fixture.call("auth.complete", json!({"challenge":start["challenge"],"credentials":{"MUSIC_U":"synthetic-token","__csrf":"synthetic-csrf"}})).await;
    assert_eq!(completed["session"]["state"], "signed_in");
    account.assert_async().await;
}
