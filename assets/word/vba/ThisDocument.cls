Attribute VB_Name = "ThisDocument"
Attribute VB_Base = "0{00020906-0000-0000-C000-000000000046}"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = True
Attribute VB_TemplateDerived = False
Attribute VB_Customizable = True
' Application event sink for the Word AI buttons.
'
' Word only re-queries a custom ribbon getEnabled callback on an explicit
' Invalidate, so the "only clickable with a selection" state needs the
' Application events wired from a class module. ThisDocument IS a class
' module in a global template; AutoExec (DshLibCore) calls DshLibInstallEvents
' once at Word startup.
'
' The handler stays deliberately tiny: it only fires the ribbon invalidate
' when the has-selection state actually flips (every keystroke / cursor move
' raises WindowSelectionChange, invalidating on each one would churn).
Private WithEvents App As Application
Private AiLastHasSel As Long

Public Sub DshLibInstallEvents()
    On Error Resume Next
    If App Is Nothing Then Set App = Application
    On Error GoTo 0
End Sub

Private Sub App_WindowSelectionChange(ByVal Sel As Selection)
    On Error Resume Next
    Dim hasSel As Long
    hasSel = 0
    If Sel.Start <> Sel.End Then hasSel = 1
    If hasSel <> AiLastHasSel Then
        AiLastHasSel = hasSel
        DshLibCore.DshLibAiEventsReady
        DshLibRibbon.DshLibRibbonInvalidateAi
    End If
    On Error GoTo 0
End Sub

Private Sub App_WindowActivate(ByVal Doc As Document, ByVal Wn As Window)
    On Error Resume Next
    AiLastHasSel = -1
    DshLibCore.DshLibAiEventsReady
    DshLibRibbon.DshLibRibbonInvalidateAi
    On Error GoTo 0
End Sub

Private Sub App_DocumentChange()
    On Error Resume Next
    AiLastHasSel = -1
    DshLibRibbon.DshLibRibbonInvalidateAi
    On Error GoTo 0
End Sub
