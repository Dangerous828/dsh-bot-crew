package com.dsh.botcrew

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

@Composable
fun CrewRoot(client: CrewClient) {
    var conversation by remember { mutableStateOf<Conversation?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var draft by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()

    fun refresh() {
        scope.launch {
            try {
                val fresh = client.timeline()
                conversation = fresh
                problem = null
            } catch (error: Exception) {
                problem = error.message
            }
        }
    }

    LaunchedEffect(Unit) { refresh() }

    Column(modifier = Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Bot 队伍", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            conversation?.let { Text("${it.bots.size} 位", style = MaterialTheme.typography.labelSmall) }
            TextButton(onClick = { refresh() }) { Text("刷新") }
        }

        problem?.let {
            Text("连不上队伍：$it", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error)
        }

        val shown = conversation
        when {
            shown == null && problem == null -> {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                    CircularProgressIndicator()
                }
            }
            shown != null && shown.messages.isEmpty() -> {
                Text("还没有人说话。在下面写一句试试。", style = MaterialTheme.typography.bodySmall)
            }
            shown != null -> {
                LazyColumn(state = listState, modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(shown.messages, key = { it.id }) { message ->
                        MessageRow(message, shown.bots)
                    }
                }
                // 新消息到底部时自动跟着走，人不必手动划。
                LaunchedEffect(shown.messages.size) {
                    if (shown.messages.isNotEmpty()) listState.animateScrollToItem(shown.messages.size - 1)
                }
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = { Text("写一句，发给队伍") },
                modifier = Modifier.weight(1f),
            )
            Button(
                enabled = draft.isNotBlank() && !sending,
                onClick = {
                    val text = draft
                    sending = true
                    scope.launch {
                        try {
                            client.send(text, CrewWire.mentionsIn(text, conversation?.bots.orEmpty()),
                                java.util.UUID.randomUUID().toString())
                            draft = ""
                            problem = null
                            refresh()
                        } catch (error: Exception) {
                            problem = error.message
                        } finally {
                            sending = false
                        }
                    }
                },
            ) { Text(if (sending) "发送中" else "发送") }
        }

        if (shown != null && shown.bots.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (bot in shown.bots) {
                    TextButton(onClick = { draft = if (draft.isBlank()) "@${bot.name} " else "$draft @${bot.name} " }) {
                        Text("@${bot.name}")
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageRow(message: Message, bots: List<BotCard>) {
    val name = when {
        !message.fromBot -> "我"
        else -> bots.firstOrNull { it.id == message.botId }?.name ?: message.botId.orEmpty()
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(name, style = MaterialTheme.typography.labelSmall,
            fontWeight = if (message.fromBot) FontWeight.Bold else FontWeight.Normal)
        Text(message.text, style = MaterialTheme.typography.bodyMedium)
    }
}
