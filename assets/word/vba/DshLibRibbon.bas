Attribute VB_Name = "DshLibRibbon"
' Ribbon callbacks. Every button forwards to a DshLibCommand entry point in
' DshLibCore.bas; the heavy lifting happens inside the HTTP transaction loop.
Option Explicit

' Captured from <customUI onLoad=...> so the enabled state of the insert
' bibliography button can be refreshed after every command (InvalidateControl).
Private gRibbon As Object

Sub DshLibRibbonOnLoad(ribbon As IRibbonUI)
    On Error Resume Next
    Set gRibbon = ribbon
    ' The ribbon onLoad fires reliably at Word startup even when AutoExec
    ' was suppressed (macro-notification states): a second, idempotent hook
    ' for the always-on agent pump. DshLibAgentStartPump re-arms nothing if
    ' a chain is already live (gAgentChains > 0 keeps Schedule idle).
    Call DshLibAgent.DshLibAgentStartPump
    Call DshLibAgent.DshLibAgentKeepAlive
    On Error GoTo 0
End Sub

' Re-query DshLibRibbonGetInsertBibEnabled (called from DshLibCore cleanup so a
' freshly inserted or unlinked bibliography greys / re-enables the button).
Public Sub DshLibRibbonInvalidate()
    On Error Resume Next
    If Not gRibbon Is Nothing Then gRibbon.InvalidateControl "DshAddBibliography"
    On Error GoTo 0
End Sub

' Re-query the getEnabled of the two AI buttons. Called by the selection
' change sink in ThisDocument (via DshLibCore) whenever the has-selection
' state flips, so the buttons are only clickable with text selected.
Public Sub DshLibRibbonInvalidateAi()
    On Error Resume Next
    If Not gRibbon Is Nothing Then
        gRibbon.InvalidateControl "DshAiCitation"
        gRibbon.InvalidateControl "DshAiEdit"
    End If
    On Error GoTo 0
End Sub

' Enabled only while a non-empty selection exists. Until the selection-change
' event sink proves alive, DshLibAiGetEnabled reports True (a permanently
' greyed-out button would be worse than a click guard); the click handler
' itself re-checks and explains.
Sub DshLibRibbonGetAiEnabled(control As IRibbonControl, ByRef enabled)
    On Error Resume Next
    enabled = DshLibCore.DshLibAiGetEnabled()
    ' Any getEnabled query proves the ribbon is alive: revive the agent pump
    ' if Word silently dropped its OnTime chain (modal states do that).
    Call DshLibAgent.DshLibAgentKeepAlive
    If Err.Number <> 0 Then enabled = True
    On Error GoTo 0
End Sub

Sub DshLibRibbonAiCitation(button As IRibbonControl)
    Call DshLibCore.DshLibAiCitation
End Sub

Sub DshLibRibbonAiEdit(button As IRibbonControl)
    Call DshLibCore.DshLibAiEdit
End Sub

Sub DshLibRibbonAddEditCitation(button As IRibbonControl)
    Call DshLibAddEditCitation
End Sub

Sub DshLibRibbonInsertBibliography(button As IRibbonControl)
    Call DshLibInsertBibliography
End Sub

Sub DshLibRibbonEditBibliography(button As IRibbonControl)
    Call DshLibEditBibliography
End Sub

' False while the active document already carries a bibliography field or
' bookmark, so the insert button greys out and editing takes over. Local scan
' only (no HTTP): a failed probe keeps the button enabled and the host-side
' addBibliography guard explains the situation if it is clicked anyway.
Sub DshLibRibbonGetInsertBibEnabled(control As IRibbonControl, ByRef enabled)
    On Error Resume Next
    enabled = Not DshLibDocHasBibliography()
    If Err.Number <> 0 Then enabled = True
    On Error GoTo 0
End Sub

Sub DshLibRibbonSetDocPrefs(button As IRibbonControl)
    Call DshLibSetDocPrefs
End Sub

Sub DshLibRibbonRefresh(button As IRibbonControl)
    Call DshLibRefresh
End Sub

Sub DshLibRibbonRemoveCodes(button As IRibbonControl)
    Call DshLibRemoveCodes
End Sub

' Browse citations already present in the active document.
Sub DshLibRibbonCitationExplorer(button As IRibbonControl)
    Call DshLibCitationExplorer
End Sub

' getLabel callback kept for parity with the reference template. Word 2013
' (15.x) uppercases custom tab labels; UCase$ is a no-op for the CJK label,
' but the version check mirrors the original DshLibCore behaviour.
' The "?" buttons beside every command. Their Chinese explanation travels in
' the Ribbon control's Tag (UTF-8 customUI.xml), so this module stays pure
' ASCII and VBE's ANSI import can never corrupt it. Hovering the button shows
' the same text as its supertip; clicking opens it in a message box.
Sub DshLibRibbonHelp(button As IRibbonControl)
    Dim helpText As String
    On Error Resume Next
    helpText = button.Tag
    On Error GoTo 0
    If Len(helpText) = 0 Then Exit Sub
    MsgBox helpText, vbInformation, _
        DshLibCN("6587 5E93 5F15 7528 0020 529F 80FD 8BF4 660E")
End Sub

Sub DshLibTabLabel(tb As IRibbonControl, ByRef returnedVal)
    Dim ver As Double
    Dim labelText As String
    labelText = DshLibCN("6587 5E93 5F15 7528")   ' dsh library citation plugin
    ver = Val(Application.Version)
    If ver >= 15 And ver < 16 Then
        returnedVal = UCase$(labelText)
    Else
        returnedVal = labelText
    End If
End Sub
