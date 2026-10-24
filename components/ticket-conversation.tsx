'use client'

import { useEffect, useRef } from 'react'

type Message = { sender: string; text: string; time: string }

export function TicketConversation({ requester, problem, messages }: { requester: string; problem: string; messages: Message[] }) {
  const box = useRef<HTMLDivElement>(null)
  const rows: Message[] = [{ sender: requester, text: problem, time: '' }, ...messages]

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [messages.length])

  return (
    <div ref={box} className="conversation">
      {rows.map((row, index) => {
        const mine = row.sender === requester
        return (
          <div key={index} className={`bubble ${mine ? 'bubble-owner' : 'bubble-staff'}`}>
            <div className="bubble-head">
              <b>{row.sender}</b>
              {index === 0 ? <span>وصف المشكلة</span> : row.time && <span>{row.time}</span>}
            </div>
            <div>{row.text}</div>
          </div>
        )
      })}
    </div>
  )
}
