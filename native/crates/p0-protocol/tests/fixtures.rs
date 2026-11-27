use p0_protocol::{
    AccessTokenResponse, ApprovalDecision, DomainEvent, ExecutionEnvironmentDescriptor,
    OrchestrationCommand, RuntimeMode, ShellStreamItem, ThreadStatus, ThreadStreamItem, TokenType,
    TurnItem,
};

#[test]
fn golden_oauth_access_token_roundtrip() {
    let raw = include_str!("../fixtures/oauth_access_token.json");
    let decoded: AccessTokenResponse = serde_json::from_str(raw).unwrap();
    assert_eq!(decoded.access_token, "eyJ2IjoyfQ.sig");
    assert_eq!(decoded.token_type, TokenType::Bearer);
    assert_eq!(decoded.expires_in, 3600.0);

    let reencoded = serde_json::to_string(&decoded).unwrap();
    let again: AccessTokenResponse = serde_json::from_str(&reencoded).unwrap();
    assert_eq!(decoded, again);
}

#[test]
fn golden_environment_descriptor_roundtrip() {
    let raw = include_str!("../fixtures/environment_descriptor.json");
    let decoded: ExecutionEnvironmentDescriptor = serde_json::from_str(raw).unwrap();
    assert_eq!(decoded.environment_id, "env-local-1");
    assert_eq!(decoded.orchestration_protocol_version, Some(2));
    assert_eq!(decoded.platform.os, "linux");

    let reencoded = serde_json::to_string(&decoded).unwrap();
    let again: ExecutionEnvironmentDescriptor = serde_json::from_str(&reencoded).unwrap();
    assert_eq!(decoded, again);
}

#[test]
fn golden_shell_snapshot_event_roundtrip() {
    let raw = include_str!("../fixtures/shell_snapshot_event.json");
    let decoded: ShellStreamItem = serde_json::from_str(raw).unwrap();
    match &decoded {
        ShellStreamItem::Snapshot { snapshot } => {
            assert_eq!(snapshot.snapshot_sequence, 42);
            assert_eq!(snapshot.projects.len(), 1);
            assert_eq!(snapshot.projects[0].title, "p0code");
            assert_eq!(snapshot.threads.len(), 1);
            assert_eq!(snapshot.threads[0].status, ThreadStatus::Completed);
            assert_eq!(snapshot.threads[0].runtime_mode, RuntimeMode::ApprovalRequired);
            assert!(snapshot.threads[0].is_unread());
        }
        other => panic!("expected snapshot, got {other:?}"),
    }

    let reencoded = serde_json::to_string(&decoded).unwrap();
    let again: ShellStreamItem = serde_json::from_str(&reencoded).unwrap();
    assert_eq!(decoded, again);
}

#[test]
fn golden_thread_snapshot_event_roundtrip() {
    let raw = include_str!("../fixtures/thread_snapshot_event.json");
    let decoded: ThreadStreamItem = serde_json::from_str(raw).unwrap();
    match &decoded {
        ThreadStreamItem::Snapshot {
            snapshot_sequence,
            projection,
            ..
        } => {
            assert_eq!(*snapshot_sequence, 42);
            assert_eq!(projection.thread.id, "thread-1");
            assert_eq!(projection.visible_turn_items.len(), 3);
            assert!(matches!(
                projection.visible_turn_items[0].item,
                TurnItem::UserMessage { .. }
            ));
            assert!(matches!(
                projection.visible_turn_items[1].item,
                TurnItem::AssistantMessage { .. }
            ));
            assert!(matches!(
                projection.visible_turn_items[2].item,
                TurnItem::ApprovalRequest { .. }
            ));
            assert_eq!(projection.runtime_requests.len(), 1);
        }
        other => panic!("expected snapshot, got {other:?}"),
    }

    let reencoded = serde_json::to_string(&decoded).unwrap();
    let again: ThreadStreamItem = serde_json::from_str(&reencoded).unwrap();
    assert_eq!(decoded, again);
}

#[test]
fn golden_domain_event_and_commands_roundtrip() {
    let evt_raw = include_str!("../fixtures/domain_event_turn_item.json");
    let evt: DomainEvent = serde_json::from_str(evt_raw).unwrap();
    assert!(matches!(evt, DomainEvent::TurnItemUpdated { .. }));

    let dispatch_raw = include_str!("../fixtures/command_message_dispatch.json");
    let dispatch: OrchestrationCommand = serde_json::from_str(dispatch_raw).unwrap();
    assert!(matches!(dispatch, OrchestrationCommand::MessageDispatch { .. }));

    let respond_raw = include_str!("../fixtures/command_runtime_request_respond.json");
    let respond: OrchestrationCommand = serde_json::from_str(respond_raw).unwrap();
    match &respond {
        OrchestrationCommand::RuntimeRequestRespond { decision, .. } => {
            assert_eq!(*decision, Some(ApprovalDecision::Accept));
        }
        other => panic!("unexpected command: {other:?}"),
    }

    let interrupt_raw = include_str!("../fixtures/command_run_interrupt.json");
    let interrupt: OrchestrationCommand = serde_json::from_str(interrupt_raw).unwrap();
    assert!(matches!(interrupt, OrchestrationCommand::RunInterrupt { .. }));

    for cmd in [dispatch, respond, interrupt] {
        let json = serde_json::to_string(&cmd).unwrap();
        let again: OrchestrationCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(cmd, again);
    }
}

#[test]
fn unknown_variants_deserialize_gracefully() {
    let unknown_shell: ShellStreamItem =
        serde_json::from_str(r#"{"kind":"future.event","extra":123}"#).unwrap();
    assert_eq!(unknown_shell, ShellStreamItem::Unknown);

    let unknown_thread: ThreadStreamItem =
        serde_json::from_str(r#"{"kind":"future.thread.event"}"#).unwrap();
    assert_eq!(unknown_thread, ThreadStreamItem::Unknown);

    let unknown_turn_item: TurnItem =
        serde_json::from_str(r#"{"type":"future_widget","id":"x","foo":true}"#).unwrap();
    assert_eq!(unknown_turn_item, TurnItem::Unknown);

    let unknown_domain: DomainEvent =
        serde_json::from_str(r#"{"type":"future.domain.event","payload":{}}"#).unwrap();
    assert_eq!(unknown_domain, DomainEvent::Unknown);

    let unknown_status: ThreadStatus = serde_json::from_str(r#""super_turbo""#).unwrap();
    assert_eq!(unknown_status, ThreadStatus::Unknown);
}
